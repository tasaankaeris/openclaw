/**
 * Attachment hydration: download to workspace, path validation, URL canonicalization.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import {
  fetchWithRetry,
  RETRYABLE_HTTP_STATUSES,
} from "./api-client";
import type { DiscordThreadReadMessage, ProjectedAttachment } from "./message-projection";

export const ATTACHMENT_HYDRATION_MAX_RETRIES = 3;
export const ATTACHMENT_HYDRATION_MAX_DELAY_MS = 10_000;
const ATTACHMENT_HYDRATION_ERROR_MAX_LEN = 120;

/** Default container workdir when config does not specify one. We copy the basic design from src (e.g. sandbox-paths); this should properly be part of the plugin SDK and not assumed here. */
export const DEFAULT_SANDBOX_CONTAINER_WORKDIR = "/workspace";

export type ToolLogger = {
  debug?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
};

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

export async function hydrateProjectedMessageAttachments(params: {
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
