import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { resolveDiscordAccount } from "openclaw/plugin-sdk";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const RATE_LIMIT_MAX_RETRIES = 3;
const RATE_LIMIT_MAX_DELAY_MS = 10_000;

export type DiscordChannel = {
  id: string;
  type: number;
  guild_id?: string;
  parent_id?: string;
};

/** Discord channel type: 1 = DM, 3 = group DM. */
export const DISCORD_CHANNEL_TYPE_DM = 1;
export const DISCORD_CHANNEL_TYPE_GROUP_DM = 3;

export function resolveDiscordBotToken(params: {
  cfg?: OpenClawConfig;
  accountId: string;
}): string {
  const cfg = params.cfg;
  if (!cfg) {
    throw new Error("Discord config is not available.");
  }
  const account = resolveDiscordAccount({
    cfg,
    accountId: params.accountId,
  });
  if (!account.enabled || !account.token) {
    throw new Error(
      `Discord account "${account.accountId}" is not enabled or missing token.`,
    );
  }
  return account.token;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function discordFetch(
  token: string,
  url: string,
  init: RequestInit & { method: string },
): Promise<Response> {
  let lastRes: Response | null = null;
  for (let attempt = 0; attempt <= RATE_LIMIT_MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bot ${token}`,
        ...(init.headers ?? {}),
      },
    });
    if (res.status !== 429) {
      return res;
    }
    lastRes = res;
    if (attempt === RATE_LIMIT_MAX_RETRIES) {
      break;
    }
    let delayMs = 1000;
    try {
      const retryAfter = res.headers.get("Retry-After");
      if (retryAfter) {
        const seconds = parseInt(retryAfter, 10);
        if (Number.isFinite(seconds)) {
          delayMs = Math.min(seconds * 1000, RATE_LIMIT_MAX_DELAY_MS);
        }
      } else {
        const data = await res.json().catch(() => ({}));
        const raw = (data as { retry_after?: number }).retry_after;
        if (typeof raw === "number" && Number.isFinite(raw)) {
          delayMs = Math.min(raw * 1000, RATE_LIMIT_MAX_DELAY_MS);
        }
      }
    } catch {
      // use default delayMs
    }
    await sleep(delayMs);
  }
  const body = lastRes ? await lastRes.text() : "";
  throw new Error(
    formatDiscordError("request", lastRes?.status ?? 429, body.slice(0, 500)),
  );
}

export function formatDiscordError(
  operation: string,
  status: number,
  bodySnippet: string,
): string {
  return `Discord ${operation} failed (${status}): ${bodySnippet || "<no body>"}`;
}

export function assertDmChannel(channel: DiscordChannel): void {
  if (
    channel.type !== DISCORD_CHANNEL_TYPE_DM &&
    channel.type !== DISCORD_CHANNEL_TYPE_GROUP_DM
  ) {
    throw new Error(
      `Channel ${channel.id} is not a DM or group DM (type=${channel.type}).`,
    );
  }
}

/**
 * Normalize emoji for Discord's reaction API URL. Strips variation selectors
 * (U+FE0E, U+FE0F) so unicode emoji match what Discord expects; converts custom
 * emoji <:name:id> / <a:name:id> to name:id. Returns URL-encoded string.
 */
export function normalizeReactionEmoji(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("emoji is required for reactions.");
  }
  const customMatch = trimmed.match(/^<a?:([^:>]+):(\d+)>$/);
  const identifier = customMatch
    ? `${customMatch[1]}:${customMatch[2]}`
    : trimmed.replace(/\uFE0E|\uFE0F/g, "");
  return encodeURIComponent(identifier);
}

/** Reject data URLs and base64-looking input; attachments are path-only to avoid token bloat. */
function rejectNonPathAttachmentInput(filePath: string): void {
  const trimmed = filePath.trim();
  if (trimmed.toLowerCase().startsWith("data:")) {
    throw new Error(
      "Attachments must be a filesystem path only. Base64/data URLs are not supported (they duplicate content and confuse agents). Use a path like /workspace/tmp/file.png or tmp/file.png.",
    );
  }
  const hasPathSep = /[/\\]/.test(trimmed) || trimmed.startsWith(".");
  if (!hasPathSep && trimmed.length > 256) {
    throw new Error(
      "Attachments must be a filesystem path (e.g. /workspace/tmp/file.png). Base64 or inline data is not supported; write the file to disk first and pass its path.",
    );
  }
}

export type ValidateAttachmentPathOptions = {
  /** When set, resolve relative paths against this root (agent workspace under OpenClaw root). */
  workspaceRoot?: string;
  /** When true, agent's workspace is mounted at /workspace; map /workspace/... to workspaceRoot. When false, workspace is at workspaceRoot and paths are relative to it. */
  sandboxed?: boolean;
};

/**
 * Normalize and validate path; must stay under allowed roots (or under workspaceRoot when provided).
 * Sandboxed: agent sees workspace at /workspace → map to workspaceRoot. Not sandboxed: workspace at workspaceRoot, paths relative to it.
 * Returns the resolved absolute path for reading.
 */
export function validateAttachmentFilePath(
  filePath: string,
  options?: ValidateAttachmentPathOptions,
): string {
  rejectNonPathAttachmentInput(filePath);
  const normalized = path.normalize(filePath.trim());

  if (options?.workspaceRoot) {
    const root = path.resolve(options.workspaceRoot);
    let resolved: string;
    if (options.sandboxed && (normalized === "/workspace" || normalized.startsWith("/workspace/"))) {
      const suffix = normalized === "/workspace" ? "" : normalized.slice("/workspace".length).replace(/^\//, "");
      resolved = path.resolve(root, suffix);
    } else if (path.isAbsolute(normalized)) {
      resolved = path.resolve(normalized);
    } else {
      resolved = path.resolve(root, normalized);
    }
    const rel = path.relative(root, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(
        `File path must stay inside the workspace: ${filePath}`,
      );
    }
    return resolved;
  }

  const resolved = path.resolve(normalized);
  const allowedRoots = [
    path.resolve("/workspace"),
    path.resolve("workspace"),
    path.resolve("tmp"),
    path.resolve("./tmp"),
  ];
  for (const root of allowedRoots) {
    const rel = path.relative(root, resolved);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      return resolved;
    }
    if (resolved === root) {
      return resolved;
    }
  }
  throw new Error(
    `File path is not in an allowed location (expected under /workspace, workspace, or tmp): ${filePath}`,
  );
}

export async function fetchDiscordChannel(params: {
  token: string;
  channelId: string;
}): Promise<DiscordChannel> {
  const res = await discordFetch(
    params.token,
    `${DISCORD_API_BASE}/channels/${params.channelId}`,
    { method: "GET" },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      formatDiscordError("channel fetch", res.status, body.slice(0, 500)),
    );
  }
  const raw = await safeJson<DiscordChannel>(res, "channel");
  if (!raw || typeof raw.id !== "string" || typeof raw.type !== "number") {
    throw new Error("Discord channel response missing id or type.");
  }
  return raw;
}

export async function safeJson<T>(res: Response, context: string): Promise<T> {
  let data: unknown;
  try {
    data = await res.json();
  } catch (err) {
    throw new Error(`Failed to parse Discord ${context} response: ${String(err)}`);
  }
  if (data === null || typeof data !== "object") {
    throw new Error(`Discord ${context} response is not an object.`);
  }
  return data as T;
}

export async function postAttachmentMessage(params: {
  token: string;
  channelId: string;
  form: FormData;
}): Promise<{ id: string }> {
  const res = await discordFetch(
    params.token,
    `${DISCORD_API_BASE}/channels/${params.channelId}/messages`,
    { method: "POST", body: params.form as unknown as BodyInit },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(formatDiscordError("attach", res.status, body.slice(0, 500)));
  }
  const data = await safeJson<{ id: string }>(res, "message");
  if (typeof data.id !== "string") {
    throw new Error("Discord message response missing id.");
  }
  return data;
}

export async function assertThreadBelongsToAllowedParent(params: {
  token: string;
  threadId: string;
  allowedGuildId?: string;
  allowedParentChannelIds?: string[];
}): Promise<void> {
  const channel = await fetchDiscordChannel({
    token: params.token,
    channelId: params.threadId,
  });

  if (params.allowedGuildId && channel.guild_id && channel.guild_id !== params.allowedGuildId) {
    throw new Error(
      `Thread ${params.threadId} is in guild ${channel.guild_id}, not allowed guild ${params.allowedGuildId}.`,
    );
  }

  if (
    params.allowedParentChannelIds &&
    params.allowedParentChannelIds.length > 0 &&
    channel.parent_id &&
    !params.allowedParentChannelIds.includes(channel.parent_id)
  ) {
    throw new Error(
      `Thread ${params.threadId} has parent ${channel.parent_id}, which is not in the allowed parent channel list.`,
    );
  }
}

