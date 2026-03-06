import fs from "node:fs/promises";
import path from "node:path";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk";

type Priority = "permanent" | "critical" | "medium" | "daily";
type ContextType = "thread" | "dm" | "channel";

const PRIORITY_EMOJI: Record<Priority, string> = {
  permanent: "🔒",
  critical: "🔴",
  medium: "🟡",
  daily: "🟢",
};

const MEMORY_APPEND_PARAMETERS_SCHEMA = {
  type: "object",
  properties: {
    text: {
      type: "string",
      description:
        "Information to remember. Can span multiple lines; newlines are preserved in the memory file.",
    },
    priority: {
      type: "string",
      enum: ["permanent", "critical", "medium", "daily"],
      description:
        "How important this memory is (permanent 🔒, critical 🔴, medium 🟡, daily 🟢). Defaults to daily.",
    },
    threadId: {
      type: "string",
      description:
        "Optional thread id (e.g. Discord thread/channel id). Exactly one of threadId, dmUserId, or channelId must be provided.",
    },
    dmUserId: {
      type: "string",
      description:
        "Optional direct-message user id. Exactly one of threadId, dmUserId, or channelId must be provided.",
    },
    channelId: {
      type: "string",
      description:
        "Optional channel id (e.g. Discord channel). Exactly one of threadId, dmUserId, or channelId must be provided.",
    },
    tags: {
      type: "array",
      items: {
        type: "string",
      },
      description:
        "Optional short tags (e.g. preferences, infra, onboarding). Stored as [tags:tag1,tag2] on the first line.",
    },
    date: {
      type: "string",
      description:
        "Optional ISO date (YYYY-MM-DD) for the memory file. Defaults to today's date in the agent workspace timezone.",
    },
  },
  required: ["text"],
  additionalProperties: false,
} as const;

function ensureWorkspaceWritable(ctx: OpenClawPluginToolContext): string {
  const workspaceDir = ctx.workspaceDir?.trim();
  if (!workspaceDir) {
    throw new Error("Agent workspace directory is not available for memory append.");
  }
  return workspaceDir;
}

function resolvePriorityEmoji(raw: string | undefined): { priority: Priority; emoji: string } {
  const normalized = (raw ?? "").trim().toLowerCase();
  const priority: Priority =
    normalized === "permanent" || normalized === "critical" || normalized === "medium"
      ? (normalized as Priority)
      : "daily";
  return { priority, emoji: PRIORITY_EMOJI[priority] };
}

function resolveDate(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) {
    return new Date().toISOString().slice(0, 10);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid date "${value}". Expected format YYYY-MM-DD.`);
  }
  return value;
}

function formatTimestamp(now: Date): string {
  // ISO-like without seconds: 2006-01-02T15:04
  const iso = now.toISOString();
  return iso.slice(0, 16);
}

function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const tags: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      const trimmed = entry.trim();
      if (trimmed) {
        tags.push(trimmed.replace(/[\s,]+/g, "-"));
      }
    }
  }
  return tags;
}

async function acquireLock(lockPath: string): Promise<void> {
  const maxRetries = 10;
  let backoffMs = 250;
  const staleThresholdMs = 20_000;

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, "wx");
      await handle.close();
      return;
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.code !== "EEXIST") {
        throw new Error(`Failed to acquire memory lock: ${error.message || String(error)}`);
      }

      // Lock already exists: check for staleness and self-heal if safe.
      let isStale = false;
      try {
        const stats = await fs.stat(lockPath);
        const ageMs = Date.now() - stats.mtimeMs;
        if (ageMs > staleThresholdMs) {
          isStale = true;
        }
      } catch {
        // If stat fails, treat as non-stale and fall through to backoff.
      }

      if (isStale) {
        try {
          await fs.rm(lockPath);
          // Immediately retry in next loop iteration.
          continue;
        } catch {
          // If we fail to remove a stale-looking lock, fall through to backoff.
        }
      }

      if (attempt === maxRetries - 1) {
        throw new Error("Could not acquire memory lock after multiple retries.");
      }
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      backoffMs *= 2;
    }
  }
}

async function releaseLock(lockPath: string): Promise<void> {
  try {
    await fs.rm(lockPath);
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code !== "ENOENT") {
      // Best-effort cleanup; do not throw from release.
      // eslint-disable-next-line no-console
      console.warn?.(`memory-append: failed to remove lock file ${lockPath}: ${String(error)}`);
    }
  }
}

function createMemoryAppendTool(ctx: OpenClawPluginToolContext): AnyAgentTool | null {
  return {
    name: "memory_append",
    label: "Memory Append",
    description:
      "Append a structured line into today's memory/YYYY-MM-DD.md file in the agent workspace, including priority emoji, context (thread/dm/channel), and optional tags.",
    parameters: MEMORY_APPEND_PARAMETERS_SCHEMA,
    async execute(_toolCallId, rawArgs) {
      const workspaceDir = ensureWorkspaceWritable(ctx);

      const args = rawArgs as Record<string, unknown>;
      const textRaw = readStringParam(args, "text", { required: true });
      const priorityRaw = readStringParam(args, "priority");
      const dateRaw = readStringParam(args, "date");

      const threadId = readStringParam(args, "threadId");
      const dmUserId = readStringParam(args, "dmUserId");
      const channelId = readStringParam(args, "channelId");

      const contextCandidates: Array<{ type: ContextType; id: string }> = [];
      if (threadId) {
        contextCandidates.push({ type: "thread", id: threadId });
      }
      if (dmUserId) {
        contextCandidates.push({ type: "dm", id: dmUserId });
      }
      if (channelId) {
        contextCandidates.push({ type: "channel", id: channelId });
      }

      if (contextCandidates.length !== 1) {
        throw new Error(
          "Provide exactly one of threadId, dmUserId, or channelId when calling memory_append.",
        );
      }

      const { type: contextType, id: contextId } = contextCandidates[0];

      const { priority, emoji } = resolvePriorityEmoji(priorityRaw);
      const date = resolveDate(dateRaw);
      const tags = normalizeTags(args.tags);
      const now = new Date();
      const timestamp = formatTimestamp(now);

      const memoryDir = path.join(workspaceDir, "memory");
      await fs.mkdir(memoryDir, { recursive: true });

      const filePath = path.join(memoryDir, `${date}.md`);
      const lockPath = `${filePath}.lock`;

      await acquireLock(lockPath);
      try {
        const normalizedText = textRaw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        const lines = normalizedText.split("\n");

        const contextToken = `[${contextType}:${contextId}]`;
        const tagsToken = tags.length > 0 ? ` [tags:${tags.join(",")}]` : "";
        const headerPrefix = `${emoji} ${timestamp} ${contextToken}${tagsToken} `;

        let payload: string;
        if (lines.length === 0) {
          payload = `${headerPrefix}\n`;
        } else {
          const [first, ...rest] = lines;
          const firstLine = `${headerPrefix}${first.trimEnd()}\n`;
          const restLines = rest.length > 0 ? rest.map((line) => `${line}\n`).join("") : "";
          payload = firstLine + restLines;
        }

        await fs.appendFile(filePath, payload, { encoding: "utf8" });
      } finally {
        await releaseLock(lockPath);
      }

      const relPath = path
        .relative(workspaceDir, filePath)
        .split(path.sep)
        .join("/");

      return jsonResult({
        ok: true,
        agentId: ctx.agentId,
        workspaceDir,
        path: relPath,
        date,
        priority,
        context: {
          type: context,
          id: contextId,
        },
      });
    },
  };
}

const plugin = {
  id: "memory-append",
  name: "Memory Append",
  description:
    "Append structured entries into daily memory Markdown files (memory/YYYY-MM-DD.md) in the agent workspace.",
  configSchema: {},
  register(api: OpenClawPluginApi) {
    api.registerTool((ctx) => createMemoryAppendTool(ctx), { optional: false });
  },
};

export default plugin;

