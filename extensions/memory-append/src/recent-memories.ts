import fs from "node:fs/promises";
import path from "node:path";

export type MemoryScopeType = "dm" | "thread" | "channel" | "cron" | "main";

export type MemoryScope = {
  type: MemoryScopeType;
  id: string;
};

/** Default limits for recent-memory injection. Single source of truth for defaults. */
export const DEFAULT_RECENT_MAX_LINES = 20;
export const DEFAULT_RECENT_MAX_CHARS = 4000;
export const DEFAULT_RECENT_MAX_LINE_CHARS = 800;

export type RecentMemoriesConfig = {
  maxLines: number;
  maxChars: number;
  /** Per-line truncation cap for the injected block (default 800). */
  maxLineChars: number;
};

export type ParsedMemoryLine = {
  raw: string;
  scopeType: MemoryScopeType | null;
  scopeId: string | null;
};

// Match the first context tag in the canonical position emitted by the Go writer:
// "<emoji...> <timestamp> [dm|thread|channel|cron|main:id] ..."
// We allow arbitrary prefix before the first "[" so that variations like 🔴🔴 still work.
const CONTEXT_TAG_REGEX = /^[^[]*\[(dm|thread|channel|cron|main):([^\]]+)\]/u;

export function parseMemoryLine(raw: string): ParsedMemoryLine {
  const match = CONTEXT_TAG_REGEX.exec(raw);
  if (!match) {
    return { raw, scopeType: null, scopeId: null };
  }
  const scopeType = match[1] as MemoryScopeType;
  const scopeId = match[2]?.trim() ?? "";
  if (!scopeId) {
    return { raw, scopeType: null, scopeId: null };
  }
  return { raw, scopeType, scopeId };
}

export function selectRecentMatchingLines(
  lines: string[],
  scope: MemoryScope,
  cfg: RecentMemoriesConfig,
): string[] {
  const maxLineChars = Math.max(1, cfg.maxLineChars ?? DEFAULT_RECENT_MAX_LINE_CHARS);
  const result: string[] = [];
  let totalChars = 0;

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const raw = lines[i];
    if (!raw.trim()) {
      // Ignore empty lines
      continue;
    }
    const parsed = parseMemoryLine(raw);
    if (!parsed.scopeType || !parsed.scopeId) {
      continue;
    }
    if (!isScopeMatch(scope, parsed.scopeType, parsed.scopeId)) {
      continue;
    }
    // Apply per-line truncation for hinting; keep the header + tags but avoid
    // dumping very long diary-style entries into the prompt.
    let text = parsed.raw;
    if (text.length > maxLineChars) {
      text = `${text.slice(0, maxLineChars - 1)}…`;
    }

    const nextLen = text.length;
    if (result.length >= cfg.maxLines || totalChars + nextLen > cfg.maxChars) {
      // Skip this line and continue scanning older ones; do not stop outright
      // so that a single oversized latest entry cannot starve all context.
      continue;
    }
    result.push(text);
    totalChars += nextLen;
  }

  return result.reverse();
}

/**
 * Sessions are per-thread, per-channel; we match by exact context ID only so
 * memories do not overlap and agents are not confused by cross-session context.
 */
function isScopeMatch(
  scope: MemoryScope,
  lineType: MemoryScopeType,
  lineId: string,
): boolean {
  if (scope.type === "channel") {
    if (lineType !== "channel" && lineType !== "thread") {
      return false;
    }
    return lineId === scope.id;
  }
  if (scope.type === "dm" || scope.type === "cron" || scope.type === "main") {
    return lineType === scope.type && lineId === scope.id;
  }
  if (scope.type === "thread") {
    return lineType === "thread" && lineId === scope.id;
  }
  return false;
}

export async function buildRecentMemoriesBlock(params: {
  workspaceDir: string;
  scope: MemoryScope;
  cfg: RecentMemoriesConfig;
  now?: Date;
}): Promise<string | undefined> {
  const { workspaceDir, scope, cfg } = params;
  const now = params.now ?? new Date();
  // memory-append buckets daily files by UTC date; use the same here.
  const dateStamp = now.toISOString().slice(0, 10);
  const memoryPath = path.join(workspaceDir, "memory", `${dateStamp}.md`);

  let content: string;
  try {
    content = await fs.readFile(memoryPath, "utf8");
  } catch {
    return undefined;
  }
  const allLines = content.split(/\r?\n/u);
  const recent = selectRecentMatchingLines(allLines, scope, cfg);
  if (recent.length === 0) {
    return undefined;
  }

  const header = `Recent memories (from memory/${dateStamp}.md): these are the recent relevant memories for your session.`;
  return [header, "", ...recent].join("\n");
}

