import { spawn } from "node:child_process";
import type { AnyAgentTool, OpenClawConfig, OpenClawPluginApi, PluginLogger } from "openclaw/plugin-sdk";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk";
import {
  normalizeTags,
  parseSessionContext,
  resolveDiscordBotToken,
  resolveDiscordChannelContextType,
} from "./src/helpers.js";
import {
  buildRecentMemoriesBlock,
  DEFAULT_RECENT_MAX_CHARS,
  DEFAULT_RECENT_MAX_LINE_CHARS,
  DEFAULT_RECENT_MAX_LINES,
  type MemoryScope,
  type RecentMemoriesConfig,
} from "./src/recent-memories.js";

// OpenClawPluginToolContext is not exported from the shipped openclaw/plugin-sdk package
// (missing re-export in the upstream SDK). Mirror the shape locally until that is fixed.
// Bug: openclaw/openclaw — OpenClawPluginToolContext + logger missing from plugin-sdk exports.
// Logger is available via api.logger (OpenClawPluginApi) at registration time; we close
// over it rather than accessing it through ctx.
type OpenClawPluginToolContext = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  agentDir?: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  messageChannel?: string;
  agentAccountId?: string;
  requesterSenderId?: string;
  senderIsOwner?: boolean;
  sandboxed?: boolean;
};

const MEMORY_APPEND_SOFT_TIMEOUT_MS = 20_000;
const MEMORY_APPEND_HARD_TIMEOUT_MS = 30_000;
const MAX_MEMORY_TEXT_CHARS = 4000;
const MAX_CAPTURE_BYTES = 16 * 1024;

type Priority = "permanent" | "critical" | "medium" | "daily";

type MemoryAppendPluginConfig = {
  registryUrl?: string;
  /** Key name in registryEnvFile (or OS env) holding the registry auth secret — never the literal value. */
  registryToken?: string;
  /** Path to .env file that contains registryToken. If unset, the binary reads secrets from the OS environment only. */
  registryEnvFile?: string;
  binaryPath?: string;
  discordAccountId?: string;
  recentMaxLines?: number;
  recentMaxChars?: number;
  recentMaxLineChars?: number;
};

function isDailyMemoryPath(rawPath: string): boolean {
  const normalized = rawPath.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  const filename = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
  if (!/^\d{4}-\d{2}-\d{2}\.md$/u.test(filename)) return false;
  const lower = normalized.toLowerCase();
  return lower.includes("/memory/") || lower.startsWith("memory/");
}

function extractPathsFromParams(params: Record<string, unknown>): string[] {
  const paths: string[] = [];

  const add = (value: unknown) => {
    if (typeof value === "string") {
      paths.push(value);
    } else if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string") paths.push(entry);
      }
    }
  };

  const addFromKey = (key: "path" | "file" | "files" | "paths") => {
    const value = params[key];
    if (value !== undefined) add(value);
  };

  addFromKey("path");
  addFromKey("file");
  addFromKey("files");
  addFromKey("paths");

  return paths;
}

function extractPathsFromPatchParams(params: Record<string, unknown>): string[] {
  const paths: string[] = [];

  const addFromPatchString = (patch: string) => {
    const lines = patch.split(/\r?\n/u);
    for (const line of lines) {
      const match = line.match(/^\*\*\* (?:Add|Update) File: (.+)$/u);
      if (match && match[1]) {
        paths.push(match[1].trim());
      }
    }
  };

  const rawPatch = params["patch"];
  const rawPatches = params["patches"];

  if (typeof rawPatch === "string") {
    addFromPatchString(rawPatch);
  } else if (Array.isArray(rawPatch)) {
    for (const entry of rawPatch) {
      if (typeof entry === "string") addFromPatchString(entry);
    }
  }

  if (typeof rawPatches === "string") {
    addFromPatchString(rawPatches);
  } else if (Array.isArray(rawPatches)) {
    for (const entry of rawPatches) {
      if (typeof entry === "string") addFromPatchString(entry);
    }
  }

  return paths;
}

export function shouldBlockManualMemoryEdit(
  toolName: string,
  params: Record<string, unknown>,
): boolean {
  const lowerName = toolName.toLowerCase();
  const isFsWriteTool =
    lowerName === "write" ||
    lowerName === "edit" ||
    lowerName === "apply_patch" ||
    lowerName === "delete" ||
    lowerName === "unlink" ||
    lowerName === "remove" ||
    lowerName === "rename" ||
    lowerName === "move";

  if (!isFsWriteTool) return false;

  const candidatePaths = [
    ...extractPathsFromParams(params),
    ...extractPathsFromPatchParams(params),
  ];
  return candidatePaths.some(isDailyMemoryPath);
}

const MEMORY_APPEND_PARAMETERS_SCHEMA = {
  type: "object",
  properties: {
    text: {
      type: "string",
      description: "Required. Memory content to store. Use a short summary (up to ~4000 characters).",
    },
    priority: {
      type: "string",
      enum: ["permanent", "critical", "medium", "daily"],
      description: "Optional. Importance of the memory (permanent, critical, medium, daily). Defaults to daily.",
    },
    threadId: {
      type: "string",
      description:
        "Optional. Discord thread override. Normally leave unset; Discord context is auto-detected from the session.",
    },
    channelId: {
      type: "string",
      description:
        "Optional. Discord channel override. Normally leave unset; Discord context is auto-detected from the session.",
    },
    dmUserId: {
      type: "string",
      description:
        "Optional. Discord DM user override. Normally leave unset; Discord context is auto-detected from the session.",
    },
    tags: {
      type: "array",
      items: { type: "string" },
      description:
        "Optional. Short tags (e.g. preferences, infra). Emitted as [tags:tag1,tag2] in the memory line.",
    },
  },
  required: ["text"],
  additionalProperties: false,
} as const;

function createMemoryAppendTool(
  ctx: OpenClawPluginToolContext,
  pluginCfg: MemoryAppendPluginConfig,
  logger: PluginLogger,
): AnyAgentTool | null {
  return {
    name: "memory_append",
    label: "Memory Append",
    description:
      "Append a line to today's memory file (memory/YYYY-MM-DD.md). Inputs: text (required), priority (optional, defaults to daily), and optional Discord overrides (threadId, channelId, dmUserId) plus tags. For Discord sessions, context and project are auto-detected when possible.",
    parameters: MEMORY_APPEND_PARAMETERS_SCHEMA,
    async execute(_toolCallId, rawArgs) {
      const workspaceDir = ctx.workspaceDir?.trim();
      if (!workspaceDir) {
        return jsonResult({
          ok: false,
          error: "Cannot append memory because the agent workspace directory is not available.",
        });
      }

      const args = rawArgs as Record<string, unknown>;
      const textRaw = readStringParam(args, "text", { required: true });
      if (!textRaw) {
        return jsonResult({
          ok: false,
          error: "text is required and should contain the memory you want to store.",
        });
      }
      if (textRaw.length > MAX_MEMORY_TEXT_CHARS) {
        return jsonResult({
          ok: false,
          error: `text is too long for a single memory entry. Summarise into a few paragraphs (maximum ${MAX_MEMORY_TEXT_CHARS} characters).`,
        });
      }
      const priorityRaw = readStringParam(args, "priority");
      const threadId = readStringParam(args, "threadId");
      const channelId = readStringParam(args, "channelId");
      const dmUserId = readStringParam(args, "dmUserId");
      const tags = normalizeTags(args.tags);

      const normalizedPriority = (priorityRaw ?? "").trim().toLowerCase();
      const priority: Priority =
        normalizedPriority === "permanent" ||
        normalizedPriority === "critical" ||
        normalizedPriority === "medium"
          ? (normalizedPriority as Priority)
          : "daily";

      let contextType: "thread" | "channel" | "dm" | "main" | "cron" | null = null;
      let contextId: string | null = null;

      if (threadId) {
        contextType = "thread";
        contextId = threadId;
      } else if (channelId) {
        contextType = "channel";
        contextId = channelId;
      } else if (dmUserId) {
        contextType = "dm";
        contextId = dmUserId;
      } else {
        const sessionCtx = parseSessionContext(ctx.sessionKey ?? "");
        if (sessionCtx) {
          if (sessionCtx.type === "dm") {
            contextType = "dm";
            contextId = sessionCtx.id;
          } else if (sessionCtx.type === "main") {
            contextType = "main";
            contextId = sessionCtx.id;
          } else if (sessionCtx.type === "cron") {
            contextType = "cron";
            contextId = sessionCtx.id;
          } else if (sessionCtx.type === "channel") {
            // Session key does not distinguish thread vs channel; resolve via Discord API so we emit [thread:id] vs [channel:id] correctly.
            const accountId =
              pluginCfg.discordAccountId?.trim() ?? ctx.agentAccountId ?? "";
            const botToken = accountId
              ? resolveDiscordBotToken({ cfg: ctx.config, accountId })
              : null;
            const resolved =
              await resolveDiscordChannelContextType(botToken, sessionCtx.id);
            contextType = resolved ?? "channel";
            contextId = sessionCtx.id;
          } else {
            contextType = "thread";
            contextId = sessionCtx.id;
          }
        }
      }

      const binaryPath = pluginCfg.binaryPath?.trim() || "memory-append";

      const cmdArgs: string[] = ["--memory", textRaw, "--priority", priority, "--path", `${workspaceDir}/memory`];

      if (contextType && contextId) {
        if (contextType === "thread") cmdArgs.push("--thread", contextId);
        else if (contextType === "channel") cmdArgs.push("--channel", contextId);
        else if (contextType === "dm") cmdArgs.push("--dm", contextId);
        else if (contextType === "main") cmdArgs.push("--main", contextId);
        else if (contextType === "cron") cmdArgs.push("--cron", contextId);
      }

      const registryUrl = pluginCfg.registryUrl?.trim();
      const registryToken = pluginCfg.registryToken?.trim();
      const registryEnvFile = pluginCfg.registryEnvFile?.trim();
      if (registryUrl) cmdArgs.push("--registry-url", registryUrl);
      // Pass the key name (not value) so the binary resolves the secret from env at runtime.
      if (registryToken) cmdArgs.push("--registry-token", registryToken);
      if (registryEnvFile) cmdArgs.push("--registry-env", registryEnvFile);
      for (const tag of tags) {
        cmdArgs.push("--tags", tag);
      }

      try {
        const proc = spawn(binaryPath, cmdArgs, {
          stdio: ["ignore", "pipe", "pipe"],
          env: process.env,
          cwd: workspaceDir,
        });
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let stdoutCaptured = 0;
        let stderrCaptured = 0;

        proc.stdout.on("data", (chunk: Buffer) => {
          if (stdoutCaptured < MAX_CAPTURE_BYTES) {
            const remaining = MAX_CAPTURE_BYTES - stdoutCaptured;
            const slice = remaining >= chunk.length ? chunk : chunk.subarray(0, remaining);
            stdoutChunks.push(slice);
            stdoutCaptured += slice.length;
          }
          const text = chunk.toString("utf8");
          logger.debug?.(`memory-append stdout chunk: ${text}`);
        });

        proc.stderr.on("data", (chunk: Buffer) => {
          if (stderrCaptured < MAX_CAPTURE_BYTES) {
            const remaining = MAX_CAPTURE_BYTES - stderrCaptured;
            const slice = remaining >= chunk.length ? chunk : chunk.subarray(0, remaining);
            stderrChunks.push(slice);
            stderrCaptured += slice.length;
          }
          const text = chunk.toString("utf8");
          logger.debug?.(`memory-append stderr chunk: ${text}`);
        });

        let exitCode: number | null = null;
        let exitSignal: NodeJS.Signals | null = null;

        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const done = (err?: Error | null) => {
            if (settled) return;
            settled = true;
            if (err) reject(err);
            else resolve();
          };

          const softTimeout = setTimeout(() => {
            logger.debug?.(
              `memory-append: soft timeout after ${MEMORY_APPEND_SOFT_TIMEOUT_MS}ms, sending graceful termination signal.`,
            );
            proc.kill();
          }, MEMORY_APPEND_SOFT_TIMEOUT_MS);

          const hardTimeout = setTimeout(() => {
            logger.debug?.(
              `memory-append: hard timeout after ${MEMORY_APPEND_HARD_TIMEOUT_MS}ms, forcing process termination.`,
            );
            try {
              // On non-Unix platforms, kill() ignores the signal argument.
              proc.kill("SIGKILL");
            } catch {
              proc.kill();
            }
            done(
              new Error(
                `memory-append timed out after ${MEMORY_APPEND_HARD_TIMEOUT_MS}ms (graceful stop attempted at ${MEMORY_APPEND_SOFT_TIMEOUT_MS}ms)`,
              ),
            );
          }, MEMORY_APPEND_HARD_TIMEOUT_MS);

          proc.on("close", (code, signal) => {
            clearTimeout(softTimeout);
            clearTimeout(hardTimeout);
            exitCode = typeof code === "number" ? code : null;
            exitSignal = (signal as NodeJS.Signals | null) ?? null;
            done();
          });
          proc.on("error", (err) => {
            clearTimeout(softTimeout);
            clearTimeout(hardTimeout);
            done(err as Error);
          });
        });

        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        const out = [stdout, stderr].filter(Boolean).join("\n").trim();
        if (out) logger.debug?.(`memory-append output (captured tail): ${out}`);

        if (exitSignal) {
          return jsonResult({
            ok: false,
            error: `Memory append process was terminated by signal ${exitSignal}.`,
          });
        }

        if (exitCode === null) {
          return jsonResult({
            ok: false,
            error: "Memory append process exited with unknown status.",
          });
        }

        if (exitCode !== 0) {
          const stderrTail = stderr.slice(-512).trim();
          const messageParts = [
            `memory-append exited with code ${exitCode}.`,
            stderrTail ? `Last stderr output: ${stderrTail}` : "",
          ].filter(Boolean);
          return jsonResult({
            ok: false,
            error: messageParts.join(" "),
          });
        }
      } catch (err) {
        const error = err as NodeJS.ErrnoException;
        if (error.code === "ENOENT") {
          logger.error(`memory-append: binary not found at ${binaryPath}: ${String(error)}`);
          return jsonResult({
            ok: false,
            error: `Memory append binary not found at ${binaryPath}. Install the memory-append tool or set binaryPath in plugin config.`,
          });
        }
        logger.error(`memory-append: exec failed (${binaryPath}): ${String(error)}`);
        return jsonResult({
          ok: false,
          error: `Memory append failed. The gateway could not run the memory-append binary (${binaryPath}): ${
            error.message ?? String(error)
          }`,
        });
      }

      const date = new Date().toISOString().slice(0, 10);
      const relPath = `memory/${date}.md`;

      return jsonResult({
        ok: true,
        agentId: ctx.agentId,
        workspaceDir,
        path: relPath,
        date,
        priority,
        context: contextType && contextId ? { type: contextType, id: contextId } : undefined,
      });
    },
  };
}

const plugin = {
  id: "memory-append",
  name: "Memory Append",
  description:
    "Append structured entries into daily memory Markdown files (memory/YYYY-MM-DD.md UTC). Tool inputs are text (required) and optional priority/threadId/channelId/dmUserId/tags.",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      registryUrl: {
        type: "string",
        description:
          "Optional. Project registry API base URL used to resolve Discord channels/threads to projects. If unset, the binary falls back to PROJECT_REGISTRY_URL from the environment.",
      },
      registryToken: {
        type: "string",
        description:
          "Optional. Key name in registryEnvFile (or OS environment) that holds the registry auth secret. If unset, the binary defaults to PROJECT_REGISTRY_SECRET. The literal secret value is never stored here.",
      },
      registryEnvFile: {
        type: "string",
        description:
          "Optional. Path to a .env file containing the registryToken key. If unset, the binary reads secrets from the OS environment only.",
      },
      binaryPath: {
        type: "string",
        description:
          "Optional. Explicit path to the memory-append Go binary. If unset, the plugin runs the memory-append binary from PATH.",
      },
      discordAccountId: {
        type: "string",
        description:
          "Optional. Discord bot account id for Discord/registry lookups. Defaults to ctx.agentAccountId.",
      },
      recentMaxLines: {
        type: "number",
        description:
          "Optional. Maximum number of recent memory lines to inject into prompts (default 20).",
      },
      recentMaxChars: {
        type: "number",
        description:
          "Optional. Maximum total characters of recent memory text to inject into prompts (default 4000).",
      },
      recentMaxLineChars: {
        type: "number",
        description:
          "Optional. Per-line truncation cap for recent memory lines in the prompt (default 800).",
      },
    },
  },
  register(api: OpenClawPluginApi) {
    const pluginCfg = (api.pluginConfig ?? {}) as MemoryAppendPluginConfig;
    api.registerTool((ctx) => createMemoryAppendTool(ctx, pluginCfg, api.logger), {
      optional: false,
    });
    // Enforce append-only daily memory policy: block generic filesystem tools from
    // directly modifying memory/YYYY-MM-DD.md so all writes go through memory_append.
    api.on("before_tool_call", (event) => {
      if (shouldBlockManualMemoryEdit(event.toolName, event.params)) {
        api.logger.debug?.(
          `memory-append: blocking ${event.toolName} for daily memory path to enforce memory_append.`,
        );
        return {
          block: true,
          blockReason:
            "Direct edits to daily memory files (memory/YYYY-MM-DD.md) are disabled. Use the memory_append tool instead. If there are issues with this tool, escalate to the user rather than risk accidental modification of memory.",
        };
      }
      return;
    });

    const recentCfg: RecentMemoriesConfig = {
      maxLines: Math.max(
        1,
        typeof pluginCfg.recentMaxLines === "number" && Number.isFinite(pluginCfg.recentMaxLines)
          ? Math.floor(pluginCfg.recentMaxLines)
          : DEFAULT_RECENT_MAX_LINES,
      ),
      maxChars: Math.max(
        1,
        typeof pluginCfg.recentMaxChars === "number" && Number.isFinite(pluginCfg.recentMaxChars)
          ? Math.floor(pluginCfg.recentMaxChars)
          : DEFAULT_RECENT_MAX_CHARS,
      ),
      maxLineChars: Math.max(
        1,
        typeof pluginCfg.recentMaxLineChars === "number" &&
          Number.isFinite(pluginCfg.recentMaxLineChars)
          ? Math.floor(pluginCfg.recentMaxLineChars)
          : DEFAULT_RECENT_MAX_LINE_CHARS,
      ),
    };

    api.on("before_prompt_build", async (_event, ctx) => {
      const workspaceDir = ctx.workspaceDir?.trim();
      if (!workspaceDir) {
        return;
      }
      const sessionKey = ctx.sessionKey?.trim();
      if (!sessionKey) {
        return;
      }
      const parsed = parseSessionContext(sessionKey);
      if (!parsed) {
        return;
      }
      const scope: MemoryScope = {
        type: parsed.type as MemoryScope["type"],
        id: parsed.id,
      };

      const block = await buildRecentMemoriesBlock({
        workspaceDir,
        scope,
        cfg: recentCfg,
      });
      if (!block) {
        return;
      }
      return { prependContext: block };
    });
  },
};

export default plugin;
export { createMemoryAppendTool };
