import type { OpenClawConfig, OpenClawPluginToolContext } from "openclaw/plugin-sdk";
import {
  loadWebMedia,
  resolveChannelMediaMaxBytes,
} from "openclaw/plugin-sdk";
import fs from "node:fs/promises";
import path from "node:path";
import {
  resolveSandboxContainerWorkdirFromConfig,
  validateAttachmentFilePath,
} from "../src/discord-thread-helpers";

export const DISCORD_API_BASE = "https://discord.com/api/v10";

export function ensureDiscordContext(ctx: OpenClawPluginToolContext): void {
  const channel = (ctx.messageChannel ?? "").trim().toLowerCase();
  if (channel !== "discord") {
    throw new Error(
      `discord-thread tools are only allowed in Discord sessions (got channel=${channel || "unknown"}).`,
    );
  }
}

export function requireConfig(cfg?: OpenClawConfig): OpenClawConfig {
  if (!cfg) {
    throw new Error("OpenClaw config is not available.");
  }
  return cfg;
}

export function readOptionalIntegerParam(
  params: Record<string, unknown>,
  key: string,
): number | undefined {
  const raw = params[key];
  if (raw == null) {
    return undefined;
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.trunc(raw);
  }
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Number(raw.trim());
    if (Number.isFinite(parsed)) {
      return Math.trunc(parsed);
    }
  }
  throw new Error(`${key} must be an integer.`);
}

export type DiscordThreadToolsConfig = {
  guildId?: string;
  parentChannels?: Record<string, string>;
};

export const DEFAULT_DISCORD_GUILD_ID = "1469620697293652180";
export const DEFAULT_DISCORD_PARENT_CHANNELS: Record<string, string> = {
  general: "1469620697935511564",
  system: "1469628926782341291",
  ops: "1469659372492689531",
} as const;

/** Fallback cap for attachments when no agent/channel limit is set (Discord non-nitro 8MB). */
export const DISCORD_ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;

export type ParentChannelKey = keyof typeof DEFAULT_DISCORD_PARENT_CHANNELS;

export async function loadAttachmentPayload(params: {
  cfg: OpenClawConfig;
  accountId: string;
  filePath: string;
  filename?: string;
  caption?: string;
  /** Agent workspace root (OpenClaw workspace + agent workspace name). When set, paths are resolved relative to it. */
  workspaceDir?: string;
  /** When true, agent sees workspace at container workdir; map that path to workspaceDir. When false, paths are relative to workspaceDir. */
  sandboxed?: boolean;
  /**
   * Id of the agent running the tool. Set by the runtime in plugin tool context (ctx.agentId).
   * In a typical agent + Discord run the runtime always provides it. In non-agent contexts
   * (e.g. tools catalog, HTTP invoke) it may be a default. When sandboxed we use it to
   * resolve agent-specific sandbox.docker.workdir from config.
   */
  agentId?: string;
}): Promise<FormData> {
  const containerWorkdir =
    params.sandboxed && params.cfg
      ? resolveSandboxContainerWorkdirFromConfig({ config: params.cfg, agentId: params.agentId })
      : undefined;
  const safePath = validateAttachmentFilePath(params.filePath, {
    workspaceRoot: params.workspaceDir,
    sandboxed: params.sandboxed,
    containerWorkdir,
  });
  const maxBytes =
    resolveChannelMediaMaxBytes({
      cfg: params.cfg,
      accountId: params.accountId,
      resolveChannelLimitMb: () => undefined,
    }) ?? DISCORD_ATTACHMENT_MAX_BYTES;
  // Per-agent workspace-* dirs (e.g. workspace-prism) are blocked by default localRoots
  // hardening; pass explicit localRoots so attachments under the agent workspace are allowed.
  const localRoots = params.workspaceDir ? [path.resolve(params.workspaceDir)] : undefined;
  let media: Awaited<ReturnType<typeof loadWebMedia>>;
  try {
    media = await loadWebMedia(safePath, {
      maxBytes,
      localRoots,
      readFile: (p: string) => fs.readFile(p),
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    const message = (err as Error)?.message ?? String(err);
    if (code === "ENOENT") {
      throw new Error(
        `Attachment file not found: ${safePath}. Paths are resolved using the runtime workspace. For sandboxed agents, ensure the runtime passes the correct workspace for this agent, or try using accountId "default" so the host workspace is used. ${message}`,
      );
    }
    throw err;
  }
  const effectiveFilename =
    params.filename || media.fileName || path.basename(safePath) || "attachment";
  const form = new FormData();
  form.append("files[0]", new Blob([media.buffer]), effectiveFilename);
  if (params.caption) {
    form.append("payload_json", JSON.stringify({ content: params.caption }));
  }
  return form;
}
