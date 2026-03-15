/**
 * Discord thread helper primitives used by the discord-thread-tools extension.
 *
 * Design notes for `discord-thread-read`
 * --------------------------------------
 * - The read tool is objective-neutral: it returns factual thread data plus
 *   neutral navigation primitives; it must not push intent-specific workflows.
 * - External pagination vocabulary is `earlier`/`later` to reduce ambiguity.
 *   Internally this maps directly to Discord `before`/`after` message queries.
 * - Pagination is anchor-relative for a live thread. New incoming messages may
 *   appear on `later` reads by design.
 * - Navigation actions returned by the tool are fully executable and include
 *   explicit effective optional values (no hidden defaults at replay time).
 * - Attachment output is opt-in via `includeAttachments`. When enabled, each
 *   attachment includes metadata plus hydration attempts to local
 *   `media/inbound/*` paths (per-attachment `hydrationFailure` on failure).
 * - Attachment handling remains capability-based: callers choose when to read
 *   around a message and hydrate attachments.
 * - System-message filtering (`includeSystem=false`) is presentation-only.
 *   Cursor anchors and boundary ids are derived from the raw fetched window.
 *   Read outputs include explicit `rawCount`, `filteredOutCount`, and optional
 *   `filtered` fields to make this behavior observable to callers.
 * - Around reads (`aroundMessageId`) provide centered context; callers can
 *   fetch attachment details by combining `aroundMessageId` with
 *   `includeAttachments=true`.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { resolveDiscordAccount } from "openclaw/plugin-sdk";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const RATE_LIMIT_MAX_RETRIES = 3;
const RATE_LIMIT_MAX_DELAY_MS = 10_000;
const ATTACHMENT_HYDRATION_MAX_RETRIES = 3;
const ATTACHMENT_HYDRATION_MAX_DELAY_MS = 10_000;
const ATTACHMENT_HYDRATION_ERROR_MAX_LEN = 120;
const RETRYABLE_HTTP_STATUSES = new Set([429, 503, 504]);

type ToolLogger = {
  debug?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
};

export type DiscordChannel = {
  id: string;
  type: number;
  guild_id?: string;
  parent_id?: string;
};

type DiscordRawAuthor = {
  id?: string;
  username?: string;
};

type DiscordRawAttachment = {
  id: string;
  filename?: string;
  content_type?: string;
  size?: number;
  url?: string;
  proxy_url?: string;
};

type DiscordRawEmbed = {
  type?: string;
  title?: string;
  description?: string;
  url?: string;
};

export type DiscordRawMessage = {
  id: string;
  author?: DiscordRawAuthor;
  content?: string;
  timestamp?: string;
  type?: number;
  attachments?: DiscordRawAttachment[];
  embeds?: DiscordRawEmbed[];
};

type ThreadReadCursorPayload = {
  v: 1;
  threadId: string;
  dir: "earlier" | "later";
  anchorFirstMessageId: string;
  anchorLastMessageId: string;
  limit: number;
  snapshotNewestMessageId?: string;
  issuedAt?: number;
};

export type DiscordThreadReadDirection = "earlier" | "later";

export type DiscordThreadReadParams = {
  accountId: string;
  threadId: string;
  limit?: number;
  cursor?: string;
  direction?: DiscordThreadReadDirection;
  aroundMessageId?: string;
  includeContent: boolean;
  contentMaxChars: number;
  includeSystem: boolean;
  includeEmbeds: boolean;
  includeAttachments: boolean;
  forceReDownload?: boolean;
  workspaceDir?: string;
  sandboxed?: boolean;
};

type ProjectedAttachment = {
  id: string;
  filename?: string;
  contentType?: string;
  size?: number;
  url?: string;
  proxyUrl?: string;
  localPath?: string;
  hydrationFailure?: true;
};

type ProjectedEmbed = {
  type?: string;
  title?: string;
  description?: string;
  url?: string;
};

export type DiscordThreadReadMessage = {
  id: string;
  authorId: string;
  authorName: string;
  content?: string;
  createdAt: string;
  isSystem: boolean;
  hasAttachments: boolean;
  attachmentCount: number;
  hasEmbeds: boolean;
  embedCount: number;
  attachments?: ProjectedAttachment[];
  embeds?: ProjectedEmbed[];
};

export type DiscordThreadReadResult = {
  ok: true;
  threadId: string;
  messages: DiscordThreadReadMessage[];
  returnedCount: number;
  rawCount: number;
  filteredOutCount: number;
  filtered?: { systemMessagesOmitted: number };
  earlierCursor?: string;
  laterCursor?: string;
  dedupeKey: "id";
  window: {
    oldestId: string;
    newestId: string;
    boundaryExcludesAnchor: true;
  };
  progress: {
    canReadEarlier: boolean;
    canReadLater: boolean;
  };
  attachmentMessageIds?: string[];
  capabilities: {
    attachmentDetail: string;
  };
  nextActions?: {
    readEarlierRequest?: {
      accountId: string;
      threadId: string;
      cursor: string;
      direction: "earlier";
      limit: number;
      includeContent: boolean;
      contentMaxChars: number;
      includeEmbeds: boolean;
      includeAttachments: boolean;
      includeSystem: boolean;
      forceReDownload: boolean;
    };
    readLaterRequest?: {
      accountId: string;
      threadId: string;
      cursor: string;
      direction: "later";
      limit: number;
      includeContent: boolean;
      contentMaxChars: number;
      includeEmbeds: boolean;
      includeAttachments: boolean;
      includeSystem: boolean;
      forceReDownload: boolean;
    };
    aroundMessageTemplate: {
      accountId: string;
      threadId: string;
      aroundMessageId: string;
      limit: number;
      includeAttachments: boolean;
      includeEmbeds: boolean;
      includeContent: boolean;
      contentMaxChars: number;
      includeSystem: boolean;
      forceReDownload: boolean;
    };
  };
};

/** Discord channel type: 1 = DM, 3 = group DM. */
export const DISCORD_CHANNEL_TYPE_DM = 1;
export const DISCORD_CHANNEL_TYPE_GROUP_DM = 3;

/** Discord thread channel types: 11 = public thread, 12 = private thread. */
export const DISCORD_CHANNEL_TYPE_PUBLIC_THREAD = 11;
export const DISCORD_CHANNEL_TYPE_PRIVATE_THREAD = 12;

const DISCORD_THREAD_TYPES = [DISCORD_CHANNEL_TYPE_PUBLIC_THREAD, DISCORD_CHANNEL_TYPE_PRIVATE_THREAD];

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

function parseRetryAfterMs(retryAfter: string | null, maxDelayMs: number): number | undefined {
  if (!retryAfter) {
    return undefined;
  }
  const seconds = Number.parseFloat(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.ceil(seconds * 1000), maxDelayMs);
  }
  const asDate = Date.parse(retryAfter);
  if (Number.isFinite(asDate)) {
    const delayMs = asDate - Date.now();
    if (delayMs > 0) {
      return Math.min(delayMs, maxDelayMs);
    }
  }
  return undefined;
}

function resolveRetryDelayMs(params: {
  attempt: number;
  retryAfter: string | null;
  maxDelayMs: number;
}): number {
  const fromHeader = parseRetryAfterMs(params.retryAfter, params.maxDelayMs);
  if (fromHeader != null) {
    return fromHeader;
  }
  const exp = Math.min(500 * Math.pow(2, params.attempt), params.maxDelayMs);
  return Math.max(250, Math.trunc(exp));
}

function isTransientNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const candidateCodes = [
    (err as { code?: unknown }).code,
    (err as { cause?: { code?: unknown } }).cause?.code,
  ]
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.toUpperCase());
  const knownCodes = new Set([
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "ENOTFOUND",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_SOCKET",
    "UND_ERR_CONNECT_ERROR",
  ]);
  if (candidateCodes.some((code) => knownCodes.has(code))) {
    return true;
  }
  return /(timed out|fetch failed|network|socket hang up|connection reset|temporary failure|dns)/i.test(
    err.message,
  );
}

async function fetchWithRetry(params: {
  url: string;
  init: RequestInit & { method: string };
  maxRetries: number;
  maxDelayMs: number;
  retryableStatuses?: Set<number>;
  retryNetworkErrors?: boolean;
}): Promise<Response> {
  let lastResponse: Response | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt <= params.maxRetries; attempt += 1) {
    try {
      const res = await fetch(params.url, params.init);
      if (!(params.retryableStatuses ?? RETRYABLE_HTTP_STATUSES).has(res.status)) {
        return res;
      }
      lastResponse = res;
      if (attempt === params.maxRetries) {
        return res;
      }
      await sleep(
        resolveRetryDelayMs({
          attempt,
          retryAfter: res.headers.get("Retry-After"),
          maxDelayMs: params.maxDelayMs,
        }),
      );
      continue;
    } catch (err) {
      lastError = err;
      if (!params.retryNetworkErrors || !isTransientNetworkError(err) || attempt === params.maxRetries) {
        throw err;
      }
      await sleep(
        resolveRetryDelayMs({
          attempt,
          retryAfter: null,
          maxDelayMs: params.maxDelayMs,
        }),
      );
    }
  }
  if (lastResponse) {
    return lastResponse;
  }
  throw new Error(
    `request failed: ${
      lastError instanceof Error ? lastError.message : String(lastError ?? "unknown error")
    }`,
  );
}

export async function discordFetch(
  token: string,
  url: string,
  init: RequestInit & { method: string },
): Promise<Response> {
  const method = (init.method || "GET").toUpperCase();
  const isIdempotentMethod = method === "GET" || method === "HEAD";
  const retryableStatuses = isIdempotentMethod ? RETRYABLE_HTTP_STATUSES : new Set([429]);
  return await fetchWithRetry({
    url,
    init: {
      ...init,
      headers: {
        Authorization: `Bot ${token}`,
        ...(init.headers ?? {}),
      },
      method,
    },
    maxRetries: RATE_LIMIT_MAX_RETRIES,
    maxDelayMs: RATE_LIMIT_MAX_DELAY_MS,
    retryableStatuses,
    retryNetworkErrors: isIdempotentMethod,
  });
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

/** Default container workdir when config does not specify one. We copy the basic design from src (e.g. sandbox-paths); this should properly be part of the plugin SDK and not assumed here. */
const DEFAULT_SANDBOX_CONTAINER_WORKDIR = "/workspace";

/**
 * Resolve the sandbox container workdir from config (agents.defaults.sandbox.docker.workdir
 * and agent-specific agents.list[].sandbox.docker.workdir). Used so attachment path mapping
 * respects sandbox.docker.workdir when set to something other than /workspace.
 */
export function resolveSandboxContainerWorkdirFromConfig(params: {
  config?: OpenClawConfig;
  agentId?: string;
}): string {
  const cfg = params.config;
  if (!cfg?.agents) {
    return DEFAULT_SANDBOX_CONTAINER_WORKDIR;
  }
  const defaultWorkdir =
    (cfg.agents as { defaults?: { sandbox?: { docker?: { workdir?: string } } } }).defaults?.sandbox
      ?.docker?.workdir;
  const list = (cfg.agents as { list?: Array<{ id?: string; sandbox?: { docker?: { workdir?: string } } }> })
    .list;
  let workdir: string | undefined = typeof defaultWorkdir === "string" ? defaultWorkdir.trim() : undefined;
  if (params.agentId && Array.isArray(list)) {
    const normalizedAgentId = params.agentId.trim().toLowerCase();
    const entry = list.find(
      (e) => e?.id != null && String(e.id).trim().toLowerCase() === normalizedAgentId,
    );
    const agentWorkdir = entry?.sandbox?.docker?.workdir;
    if (typeof agentWorkdir === "string" && agentWorkdir.trim()) {
      workdir = agentWorkdir.trim();
    }
  }
  if (!workdir) {
    return DEFAULT_SANDBOX_CONTAINER_WORKDIR;
  }
  const normalized = workdir.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
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
  /** When true, agent's workspace is mounted at containerWorkdir; map containerWorkdir/... to workspaceRoot. When false, workspace is at workspaceRoot and paths are relative to it. */
  sandboxed?: boolean;
  /**
   * When sandboxed, the container path where the workspace is mounted (default /workspace).
   * Not provided by the sandbox runtime. Callers that have config (and optional agentId) should
   * pass the result of resolveSandboxContainerWorkdirFromConfig({ config, agentId }) so
   * sandbox.docker.workdir is respected. Omitted when the caller does not resolve it (then /workspace is used).
   */
  containerWorkdir?: string;
};

/**
 * Normalize and validate path; must stay under allowed roots (or under workspaceRoot when provided).
 * Sandboxed: agent sees workspace at containerWorkdir (default /workspace) → map to workspaceRoot. Not sandboxed: workspace at workspaceRoot, paths relative to it.
 * Returns the resolved absolute path for reading.
 */
export function validateAttachmentFilePath(
  filePath: string,
  options?: ValidateAttachmentPathOptions,
): string {
  rejectNonPathAttachmentInput(filePath);
  const normalized = path.normalize(filePath.trim()).replace(/\\/g, "/");

  if (options?.workspaceRoot) {
    const root = path.resolve(options.workspaceRoot);
    const workdir =
      (options.sandboxed && options.containerWorkdir?.trim())
        ? options.containerWorkdir.trim().replace(/\\/g, "/").replace(/\/+$/, "") || "/"
        : DEFAULT_SANDBOX_CONTAINER_WORKDIR;
    const workdirPrefix = workdir.startsWith("/") ? workdir : `/${workdir}`;
    const isUnderWorkdir =
      normalized === workdirPrefix || (workdirPrefix !== "/" && normalized.startsWith(`${workdirPrefix}/`));
    let resolved: string;
    if (options.sandboxed && isUnderWorkdir) {
      const suffix =
        normalized === workdirPrefix ? "" : normalized.slice(workdirPrefix.length).replace(/^\//, "");
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

/**
 * Ensures the channel is a Discord thread and, when configured, that it belongs to the
 * allowed guild and parent channel list. Thread-send, thread-attach, and thread-react
 * must target a thread only; no extra arguments—callers pass a channel id and we reject
 * if it is not a thread (type 11 or 12).
 */
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

  if (!DISCORD_THREAD_TYPES.includes(channel.type)) {
    throw new Error(
      `Channel ${params.threadId} is not a thread (type ${channel.type}). ` +
        "discord-thread-send, discord-thread-attach, and discord-thread-react accept only thread channel ids.",
    );
  }

  if (params.allowedGuildId && channel.guild_id && channel.guild_id !== params.allowedGuildId) {
    throw new Error(
      `Thread ${params.threadId} is in guild ${channel.guild_id}, not allowed guild ${params.allowedGuildId}.`,
    );
  }

  if (
    params.allowedParentChannelIds &&
    params.allowedParentChannelIds.length > 0
  ) {
    if (!channel.parent_id) {
      throw new Error(
        `Thread ${params.threadId} has no parent_id; parent channel allowlist is configured so a parent is required.`,
      );
    }
    if (!params.allowedParentChannelIds.includes(channel.parent_id)) {
      throw new Error(
        `Thread ${params.threadId} has parent ${channel.parent_id}, which is not in the allowed parent channel list.`,
      );
    }
  }
}

export function isDiscordSnowflake(raw: string): boolean {
  const value = raw.trim();
  if (!/^\d{16,22}$/.test(value)) {
    return false;
  }
  try {
    void BigInt(value);
    return true;
  } catch {
    return false;
  }
}

export function encodeThreadReadCursor(payload: ThreadReadCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeThreadReadCursor(rawCursor: string): ThreadReadCursorPayload {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(rawCursor, "base64url").toString("utf8"));
  } catch (err) {
    throw new Error(`Invalid cursor format: ${String(err)}`);
  }
  if (!decoded || typeof decoded !== "object") {
    throw new Error("Invalid cursor payload.");
  }
  const cursor = decoded as Partial<ThreadReadCursorPayload>;
  if (cursor.v !== 1) {
    throw new Error(`Unsupported cursor version: ${String(cursor.v)}`);
  }
  if (typeof cursor.threadId !== "string" || !isDiscordSnowflake(cursor.threadId)) {
    throw new Error("Cursor missing valid threadId.");
  }
  if (cursor.dir !== "earlier" && cursor.dir !== "later") {
    throw new Error("Cursor missing valid dir.");
  }
  if (
    typeof cursor.anchorFirstMessageId !== "string" ||
    !isDiscordSnowflake(cursor.anchorFirstMessageId)
  ) {
    throw new Error("Cursor missing valid anchorFirstMessageId.");
  }
  if (
    typeof cursor.anchorLastMessageId !== "string" ||
    !isDiscordSnowflake(cursor.anchorLastMessageId)
  ) {
    throw new Error("Cursor missing valid anchorLastMessageId.");
  }
  if (typeof cursor.limit !== "number" || !Number.isFinite(cursor.limit)) {
    throw new Error("Cursor missing valid limit.");
  }
  return cursor as ThreadReadCursorPayload;
}

function clipText(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }
  if (maxChars <= 0) {
    return "";
  }
  return `${content.slice(0, maxChars)} ...(truncated)`;
}

function messageIdComparatorAsc(a: string, b: string): number {
  try {
    const aBig = BigInt(a);
    const bBig = BigInt(b);
    if (aBig < bBig) {
      return -1;
    }
    if (aBig > bBig) {
      return 1;
    }
    return 0;
  } catch {
    return a.localeCompare(b);
  }
}

function normalizeMessagesOldestToNewest(messages: DiscordRawMessage[]): DiscordRawMessage[] {
  return [...messages].sort((a, b) => messageIdComparatorAsc(a.id, b.id));
}

function toHostPathFromPosixRelative(baseDir: string, relativePath: string): string {
  return path.join(baseDir, ...relativePath.split("/"));
}

function truncateErrorSummary(message: string): string {
  const trimmed = message.trim();
  if (!trimmed) {
    return "attachment hydration failed";
  }
  if (trimmed.length <= ATTACHMENT_HYDRATION_ERROR_MAX_LEN) {
    return trimmed;
  }
  return `${trimmed.slice(0, ATTACHMENT_HYDRATION_ERROR_MAX_LEN - 3)}...`;
}

async function fetchAttachmentWithRetry(params: {
  url: string;
  token: string;
}): Promise<Response> {
  return await fetchWithRetry({
    url: params.url,
    init: {
      method: "GET",
      headers: { Authorization: `Bot ${params.token}` },
    },
    maxRetries: ATTACHMENT_HYDRATION_MAX_RETRIES,
    maxDelayMs: ATTACHMENT_HYDRATION_MAX_DELAY_MS,
    retryableStatuses: RETRYABLE_HTTP_STATUSES,
    retryNetworkErrors: true,
  });
}

function canonicalizeAttachmentUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

// RFC 4122 Appendix C: URL namespace UUID for name-based UUIDs from URLs.
export const URL_NAMESPACE_UUID = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

/**
 * Deterministic UUID from SHA-256 of (namespace + canonical URL) per RFC 9562.
 * RFC 4122 permits only SHA-1 for version 5; name-based UUIDs from SHA-256 MUST use
 * UUIDv8 (RFC 9562 §5.8, §5.5 note, Appendix B.2).
 * Concatenates URL namespace UUID bytes + canonical URL UTF-8 bytes, hashes with SHA-256,
 * takes first 16 octets, sets version nibble (octet 6) to 8 and variant (octet 8) to 10xx.
 */
export function canonicalUrlToGuid(canonicalUrl: string): string {
  const namespaceBytes = Buffer.from(URL_NAMESPACE_UUID.replace(/-/g, ""), "hex");
  const nameBytes = Buffer.from(canonicalUrl, "utf8");
  const combined = Buffer.concat([namespaceBytes, nameBytes]);
  const hash = crypto.createHash("sha256").update(combined).digest();
  const raw = hash.subarray(0, 16);
  raw[6] = (raw[6]! & 0x0f) | 0x80; // version 8 (RFC 9562)
  raw[8] = (raw[8]! & 0x3f) | 0x80; // variant (RFC 4122/9562 §4.1)
  const hex = raw.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Safe attachment basename: prevents path traversal and reserved characters.
 *
 * Discord API supplies filename; normally valid, but guard against path separators (/, \),
 * dot segments (., ..), control chars, and Windows reserved chars that could break hydration.
 *
 * Security rationale:
 * - Backslash on Windows is a path separator; `toHostPathFromPosixRelative` splits only on `/`
 *   then uses `path.join`, which treats `\` as a separator on Windows. Without normalization,
 *   a filename like `..\\..\\evil.txt` could escape `media/inbound/{guid}`.
 * - Forward-slash and dot-segments can also escape or collide.
 * - Control chars and Windows reserved chars (: * ? " < > |) may cause IO failures.
 *
 * Falls back to hash when any dangerous character is present or basename is empty/dot-segment.
 */
function safeAttachmentBasename(filename: string | undefined, hash: string): string {
  if (!filename || !filename.trim()) return hash;
  const normalized = filename.trim().replaceAll("\\", "/");
  const base = path.posix.basename(normalized);
  if (!base || base === "." || base === "..") return hash;
  // Reject any remaining path separators (shouldn't happen post-basename, but defensive)
  if (base.includes("/") || base.includes("\\")) return hash;
  // Reject control chars (0x00-0x1F, 0x7F) and Windows reserved chars (: * ? " < > |)
  if (/[\x00-\x1F\x7F:*?"<>|]/.test(base)) return hash;
  return base;
}

function resolveHydrationRelativePath(url: string, filename?: string): string {
  const canonical = canonicalizeAttachmentUrl(url);
  const hash = crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
  const guid = canonicalUrlToGuid(canonical);
  const safeName = safeAttachmentBasename(filename, hash);
  return path.posix.join("media", "inbound", guid, safeName);
}

function resolveCallerLocalPath(params: {
  workspaceDir: string;
  relativePath: string;
  sandboxed?: boolean;
}): string {
  if (params.sandboxed) {
    return params.relativePath;
  }
  return toHostPathFromPosixRelative(params.workspaceDir, params.relativePath);
}

async function existsOnDisk(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function hasReusableCachedFile(filePath: string, expectedSize?: number): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size <= 0) {
      return false;
    }
    if (typeof expectedSize === "number" && Number.isFinite(expectedSize) && expectedSize >= 0) {
      return stat.size === expectedSize;
    }
    return true;
  } catch {
    return false;
  }
}

async function writeFileAtomic(targetPath: string, data: Buffer): Promise<void> {
  const tmpPath = `${targetPath}.tmp-${crypto.randomUUID()}`;
  await fs.writeFile(tmpPath, data);
  try {
    await fs.rename(tmpPath, targetPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "EEXIST" && code !== "EPERM") {
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    }
    const backupPath = `${targetPath}.bak-${crypto.randomUUID()}`;
    let movedOriginalToBackup = false;
    try {
      await fs.rename(targetPath, backupPath);
      movedOriginalToBackup = true;
      await fs.rename(tmpPath, targetPath);
      await fs.rm(backupPath, { force: true }).catch(() => {});
    } catch (swapErr) {
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      if (movedOriginalToBackup) {
        const targetExists = await existsOnDisk(targetPath);
        if (!targetExists) {
          await fs.rename(backupPath, targetPath).catch(() => {});
        } else {
          await fs.rm(backupPath, { force: true }).catch(() => {});
        }
      }
      throw swapErr;
    }
  }
}

async function hydrateAttachmentToWorkspace(params: {
  attachment: ProjectedAttachment;
  token: string;
  workspaceDir?: string;
  sandboxed?: boolean;
  forceReDownload?: boolean;
  logger?: ToolLogger;
}): Promise<Pick<ProjectedAttachment, "localPath" | "hydrationFailure">> {
  // TODO: future hardening - if primary `url` fails, attempt one fallback fetch via `proxyUrl`.
  const sourceUrl = params.attachment.url ?? params.attachment.proxyUrl;
  if (!sourceUrl || !sourceUrl.trim()) {
    params.logger?.warn?.(
      "discord-thread-read attachment hydration failed: attachment missing URL/proxyUrl",
      { attachmentId: params.attachment.id },
    );
    return { hydrationFailure: true };
  }
  if (!params.workspaceDir) {
    params.logger?.warn?.(
      "discord-thread-read attachment hydration failed: workspaceDir unavailable",
      { attachmentId: params.attachment.id, url: sourceUrl },
    );
    return { hydrationFailure: true };
  }

  const relativePath = resolveHydrationRelativePath(sourceUrl, params.attachment.filename);
  const destination = toHostPathFromPosixRelative(params.workspaceDir, relativePath);
  const shouldReuse =
    !params.forceReDownload &&
    (await hasReusableCachedFile(destination, params.attachment.size));
  if (shouldReuse) {
    return {
      localPath: resolveCallerLocalPath({
        workspaceDir: params.workspaceDir,
        relativePath,
        sandboxed: params.sandboxed,
      }),
    };
  }

  try {
    const res = await fetchAttachmentWithRetry({ url: sourceUrl, token: params.token });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const body = Buffer.from(await res.arrayBuffer());
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await writeFileAtomic(destination, body);
    return {
      localPath: resolveCallerLocalPath({
        workspaceDir: params.workspaceDir,
        relativePath,
        sandboxed: params.sandboxed,
      }),
    };
  } catch (err) {
    params.logger?.warn?.("discord-thread-read attachment hydration failed", {
      attachmentId: params.attachment.id,
      url: sourceUrl,
      error:
        err instanceof Error
          ? truncateErrorSummary(err.message)
          : truncateErrorSummary(String(err)),
    });
    return { hydrationFailure: true };
  }
}

async function hydrateProjectedMessageAttachments(params: {
  messages: DiscordThreadReadMessage[];
  token: string;
  workspaceDir?: string;
  sandboxed?: boolean;
  forceReDownload?: boolean;
  logger?: ToolLogger;
}): Promise<void> {
  for (const message of params.messages) {
    if (!Array.isArray(message.attachments) || message.attachments.length === 0) {
      continue;
    }
    for (const attachment of message.attachments) {
      const hydration = await hydrateAttachmentToWorkspace({
        attachment,
        token: params.token,
        workspaceDir: params.workspaceDir,
        sandboxed: params.sandboxed,
        forceReDownload: params.forceReDownload,
        logger: params.logger,
      });
      if (hydration.localPath) {
        attachment.localPath = hydration.localPath;
      }
      if (hydration.hydrationFailure) {
        attachment.hydrationFailure = true;
      }
    }
  }
}

function projectMessage(raw: DiscordRawMessage, params: DiscordThreadReadParams): DiscordThreadReadMessage | null {
  const type = raw.type ?? 0;
  const isSystem = type !== 0;
  if (!params.includeSystem && isSystem) {
    return null;
  }
  const attachments = Array.isArray(raw.attachments) ? raw.attachments : [];
  const embeds = Array.isArray(raw.embeds) ? raw.embeds : [];
  return {
    id: raw.id,
    authorId: raw.author?.id ?? "",
    authorName: raw.author?.username ?? "",
    content:
      params.includeContent && typeof raw.content === "string"
        ? clipText(raw.content, params.contentMaxChars)
        : undefined,
    createdAt: raw.timestamp ?? "",
    isSystem,
    hasAttachments: attachments.length > 0,
    attachmentCount: attachments.length,
    hasEmbeds: embeds.length > 0,
    embedCount: embeds.length,
    attachments: params.includeAttachments
      ? attachments.map((attachment) => ({
          id: attachment.id,
          filename: attachment.filename,
          contentType: attachment.content_type,
          size: attachment.size,
          url: attachment.url,
          proxyUrl: attachment.proxy_url,
        }))
      : undefined,
    embeds: params.includeEmbeds
      ? embeds.map((embed) => ({
          type: embed.type,
          title: embed.title,
          description: embed.description,
          url: embed.url,
        }))
      : undefined,
  };
}

function buildChannelMessagesUrl(params: {
  channelId: string;
  limit: number;
  before?: string;
  after?: string;
  around?: string;
}): string {
  const search = new URLSearchParams();
  search.set("limit", String(params.limit));
  if (params.before) {
    search.set("before", params.before);
  }
  if (params.after) {
    search.set("after", params.after);
  }
  if (params.around) {
    search.set("around", params.around);
  }
  return `${DISCORD_API_BASE}/channels/${params.channelId}/messages?${search.toString()}`;
}

async function fetchDiscordChannelMessages(params: {
  token: string;
  channelId: string;
  limit: number;
  before?: string;
  after?: string;
  around?: string;
}): Promise<DiscordRawMessage[]> {
  const res = await discordFetch(
    params.token,
    buildChannelMessagesUrl(params),
    { method: "GET" },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(formatDiscordError("thread read", res.status, body.slice(0, 500)));
  }
  const data = await safeJson<unknown>(res, "thread read");
  if (!Array.isArray(data)) {
    throw new Error("Discord thread read response is not an array.");
  }
  return data
    .filter((entry): entry is DiscordRawMessage => {
      return !!entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string";
    })
    .map((entry) => entry as DiscordRawMessage);
}

function attachmentMessageIdsFromRaw(rawMessages: DiscordRawMessage[]): string[] {
  const ids: string[] = [];
  for (let idx = rawMessages.length - 1; idx >= 0; idx -= 1) {
    const msg = rawMessages[idx];
    if (Array.isArray(msg.attachments) && msg.attachments.length > 0) {
      ids.push(msg.id);
    }
  }
  return ids;
}

export async function readThreadMessages(params: {
  token: string;
  read: DiscordThreadReadParams;
  allowedGuildId?: string;
  allowedParentChannelIds?: string[];
  logger?: ToolLogger;
}): Promise<DiscordThreadReadResult> {
  if (params.read.cursor && params.read.aroundMessageId) {
    throw new Error("cursor and aroundMessageId are mutually exclusive.");
  }
  if (params.read.direction && !params.read.cursor) {
    throw new Error("direction requires cursor.");
  }
  if (params.read.direction && params.read.aroundMessageId) {
    throw new Error("direction cannot be used with aroundMessageId.");
  }

  await assertThreadBelongsToAllowedParent({
    token: params.token,
    threadId: params.read.threadId,
    allowedGuildId: params.allowedGuildId,
    allowedParentChannelIds: params.allowedParentChannelIds,
  });

  let effectiveDirection: DiscordThreadReadDirection = "earlier";
  let cursorPayload: ThreadReadCursorPayload | undefined;
  let before: string | undefined;
  let after: string | undefined;
  let around: string | undefined;

  if (params.read.aroundMessageId) {
    around = params.read.aroundMessageId;
  } else if (params.read.cursor) {
    cursorPayload = decodeThreadReadCursor(params.read.cursor);
    if (cursorPayload.threadId !== params.read.threadId) {
      throw new Error(
        `Cursor threadId ${cursorPayload.threadId} does not match requested threadId ${params.read.threadId}.`,
      );
    }
    effectiveDirection = params.read.direction ?? cursorPayload.dir;
    if (effectiveDirection === "earlier") {
      before = cursorPayload.anchorFirstMessageId;
    } else {
      after = cursorPayload.anchorLastMessageId;
    }
  }
  const defaultLimit = params.read.includeAttachments ? 5 : (cursorPayload?.limit ?? 30);
  const effectiveLimit = Math.min(Math.max(Math.trunc(params.read.limit ?? defaultLimit), 1), 100);
  if (params.read.includeAttachments && effectiveLimit > 5) {
    throw new Error("When includeAttachments=true, limit must be <= 5.");
  }

  const rawMessages = normalizeMessagesOldestToNewest(
    await fetchDiscordChannelMessages({
      token: params.token,
      channelId: params.read.threadId,
      limit: effectiveLimit,
      before,
      after,
      around,
    }),
  );

  const projected = rawMessages
    .map((message) => projectMessage(message, params.read))
    .filter((message): message is DiscordThreadReadMessage => !!message);
  if (params.read.includeAttachments) {
    await hydrateProjectedMessageAttachments({
      messages: projected,
      token: params.token,
      workspaceDir: params.read.workspaceDir,
      sandboxed: params.read.sandboxed,
      forceReDownload: params.read.forceReDownload,
      logger: params.logger,
    });
  }
  const returnedCount = projected.length;
  const rawCount = rawMessages.length;
  const filteredOutCount = Math.max(0, rawCount - returnedCount);
  const attachmentMessageIds = !params.read.includeAttachments
    ? attachmentMessageIdsFromRaw(rawMessages)
    : [];

  const oldestId = rawMessages[0]?.id ?? cursorPayload?.anchorFirstMessageId ?? "";
  const newestId = rawMessages[rawMessages.length - 1]?.id ?? cursorPayload?.anchorLastMessageId ?? "";
  const hasAnchors = oldestId.length > 0 && newestId.length > 0;

  let canReadEarlier = false;
  let canReadLater = false;
  if (hasAnchors) {
    if (params.read.aroundMessageId) {
      // Best-effort edge-aware around continuation.
      // If the anchor is inside the window, expose the side(s) that clearly
      // exist in-window. When Discord returned a full window we also allow both
      // directions, since edges may have more messages outside the window.
      const anchorIdx = rawMessages.findIndex((m) => m.id === params.read.aroundMessageId);
      const fullWindow = rawCount === effectiveLimit;
      if (anchorIdx >= 0) {
        canReadEarlier = fullWindow || anchorIdx > 0;
        canReadLater = fullWindow || anchorIdx < rawCount - 1;
      } else {
        canReadEarlier = fullWindow;
        canReadLater = fullWindow;
      }
    } else if (cursorPayload) {
      if (rawCount === 0) {
        // Exhausted one side; preserve opposite-direction navigation from cursor anchors.
        canReadEarlier = effectiveDirection !== "earlier";
        canReadLater = effectiveDirection !== "later";
      } else {
        canReadEarlier = true;
        canReadLater = true;
      }
    } else {
      // Initial latest-window read supports older history traversal.
      canReadEarlier = rawCount > 0;
      canReadLater = false;
    }
  }

  const makeCursor = (dir: DiscordThreadReadDirection): string | undefined => {
    if (!hasAnchors) {
      return undefined;
    }
    return encodeThreadReadCursor({
      v: 1,
      threadId: params.read.threadId,
      dir,
      anchorFirstMessageId: oldestId,
      anchorLastMessageId: newestId,
      limit: effectiveLimit,
      snapshotNewestMessageId: newestId,
      issuedAt: Date.now(),
    });
  };

  const earlierCursor = canReadEarlier ? makeCursor("earlier") : undefined;
  const laterCursor = canReadLater ? makeCursor("later") : undefined;

  const nextActions: DiscordThreadReadResult["nextActions"] = {
    aroundMessageTemplate: {
      accountId: params.read.accountId,
      threadId: params.read.threadId,
      aroundMessageId: "",
      limit: effectiveLimit,
      includeAttachments: params.read.includeAttachments,
      includeEmbeds: params.read.includeEmbeds,
      includeContent: params.read.includeContent,
      contentMaxChars: params.read.contentMaxChars,
      includeSystem: params.read.includeSystem,
      forceReDownload: !!params.read.forceReDownload,
    },
  };
  if (earlierCursor) {
    nextActions.readEarlierRequest = {
      accountId: params.read.accountId,
      threadId: params.read.threadId,
      cursor: earlierCursor,
      direction: "earlier",
      limit: effectiveLimit,
      includeContent: params.read.includeContent,
      contentMaxChars: params.read.contentMaxChars,
      includeEmbeds: params.read.includeEmbeds,
      includeAttachments: params.read.includeAttachments,
      includeSystem: params.read.includeSystem,
      forceReDownload: !!params.read.forceReDownload,
    };
  }
  if (laterCursor) {
    nextActions.readLaterRequest = {
      accountId: params.read.accountId,
      threadId: params.read.threadId,
      cursor: laterCursor,
      direction: "later",
      limit: effectiveLimit,
      includeContent: params.read.includeContent,
      contentMaxChars: params.read.contentMaxChars,
      includeEmbeds: params.read.includeEmbeds,
      includeAttachments: params.read.includeAttachments,
      includeSystem: params.read.includeSystem,
      forceReDownload: !!params.read.forceReDownload,
    };
  }

  return {
    ok: true,
    threadId: params.read.threadId,
    messages: projected,
    returnedCount,
    rawCount,
    filteredOutCount,
    filtered: params.read.includeSystem ? undefined : { systemMessagesOmitted: filteredOutCount },
    earlierCursor,
    laterCursor,
    dedupeKey: "id",
    window: {
      oldestId,
      newestId,
      boundaryExcludesAnchor: true,
    },
    progress: {
      canReadEarlier: !!earlierCursor,
      canReadLater: !!laterCursor,
    },
    attachmentMessageIds: attachmentMessageIds.length > 0 ? attachmentMessageIds : undefined,
    capabilities: {
      attachmentDetail:
        "Attachment details are available by calling discord-thread-read with a concrete aroundMessageId, includeAttachments=true, and limit <= 5.",
    },
    nextActions,
  };
}

