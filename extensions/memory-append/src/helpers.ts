import type { OpenClawConfig, PluginLogger } from "openclaw/plugin-sdk";
import { resolveDiscordAccount } from "openclaw/plugin-sdk";

const DISCORD_API_BASE = "https://discord.com/api/v10";

// Discord channel types: 10 = announcement thread, 11 = public thread, 12 = private thread
const DISCORD_THREAD_TYPES = [10, 11, 12] as const;

const DISCORD_CHANNEL_CACHE_TTL_MS = 10 * 60 * 1000; // 10 min; type/parent_id don't change
const DISCORD_CHANNEL_CACHE_MAX_SIZE = 200;

const discordChannelCache = new Map<
  string,
  { data: DiscordChannel; expiresAt: number }
>();

/** Clears the Discord channel cache. Exported for tests only. */
export function _clearDiscordChannelCacheForTests(): void {
  discordChannelCache.clear();
}

export type DiscordChannel = {
  id: string;
  type: number;
  parent_id?: string;
};

/**
 * Parses the raw sessionKey string to extract high-level context.
 * Formats:
 *   - agent:<agentId>:discord:channel:<id>  (channel or thread session; id may be thread or channel ID)
 *   - agent:<agentId>:discord:direct:<userId>  (DM session)
 *   - agent:<agentId>:main                    (main session for that agent)
 * Returns null for unsupported sessions or malformed keys.
 * Thread vs channel is not encoded in the key; use resolveDiscordChannelContextType() when you need to preserve thread identity.
 */
export function parseSessionContext(sessionKey: string): { type: string; id: string } | null {
  const parts = sessionKey.split(":");
  if (parts.length < 3) return null;

  // agent:<agentId>:main
  if (parts[2] === "main") {
    const agentId = parts[1] || "main";
    return { type: "main", id: agentId };
  }

  // agent:<agentId>:cron:<job-uuid>
  if (parts[2] === "cron" && parts.length >= 4) {
    return { type: "cron", id: parts[3] };
  }

  // Minimum length: agent : <agentId> : discord : channel/direct : <id>
  if (parts.length < 5) return null;
  if (parts[2] !== "discord") return null;
  if (parts[3] === "channel") return { type: "channel", id: parts[4] };
  if (parts[3] === "direct") return { type: "dm", id: parts[4] };
  return null;
}

/**
 * Resolves whether a Discord ID is a thread or a channel via the Discord API.
 * Call this from OpenClaw when you need to preserve thread identity in memory lines (e.g. [thread:id] vs [channel:id]).
 * Returns "thread" for types 10/11/12, "channel" otherwise, null on error or missing token.
 */
export async function resolveDiscordChannelContextType(
  botToken: string | null,
  discordId: string,
): Promise<"thread" | "channel" | null> {
  if (!botToken) return null;
  const channel = await fetchDiscordChannel(botToken, discordId);
  if (!channel) return null;
  return DISCORD_THREAD_TYPES.includes(channel.type as (typeof DISCORD_THREAD_TYPES)[number])
    ? "thread"
    : "channel";
}

/**
 * Normalises the raw tags argument (array of strings from tool params) into a clean string[].
 * Trims whitespace and replaces embedded spaces/commas with hyphens to avoid breaking the
 * [tags:a,b,c] format that the Go binary uses.
 */
export function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const tags: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      const trimmed = entry.trim().replace(/[\s,]+/g, "-");
      if (trimmed) tags.push(trimmed);
    }
  }
  return tags;
}

/**
 * Resolves the bot token for a given Discord account ID from the OpenClaw config.
 * Returns null when the account is missing, disabled, or has no token.
 */
export function resolveDiscordBotToken(params: {
  cfg?: OpenClawConfig;
  accountId: string;
}): string | null {
  const cfg = params.cfg;
  if (!cfg) return null;
  try {
    const account = resolveDiscordAccount({
      cfg,
      accountId: params.accountId,
    });
    if (!account.enabled || !account.token) return null;
    return account.token;
  } catch {
    return null;
  }
}

/**
 * Fetches a Discord channel object via the REST API.
 * Results are cached in memory (10 min TTL, max 200 entries) so repeated memory_append
 * calls in the same thread/channel do not hit Discord every time.
 * Returns null on any error (network, non-200, unexpected shape).
 */
export async function fetchDiscordChannel(
  token: string,
  channelId: string,
): Promise<DiscordChannel | null> {
  const now = Date.now();
  const cached = discordChannelCache.get(channelId);
  if (cached && cached.expiresAt > now) return cached.data;
  if (cached) discordChannelCache.delete(channelId);

  try {
    const res = await fetch(`${DISCORD_API_BASE}/channels/${channelId}`, {
      method: "GET",
      headers: { Authorization: `Bot ${token}` },
    });
    if (!res.ok) return null;
    const raw = (await res.json()) as unknown;
    if (
      !raw ||
      typeof raw !== "object" ||
      typeof (raw as DiscordChannel).id !== "string" ||
      typeof (raw as DiscordChannel).type !== "number"
    ) {
      return null;
    }
    const channel = raw as DiscordChannel;
    if (discordChannelCache.size >= DISCORD_CHANNEL_CACHE_MAX_SIZE) {
      const firstKey = discordChannelCache.keys().next().value;
      if (firstKey !== undefined) discordChannelCache.delete(firstKey);
    }
    discordChannelCache.set(channelId, {
      data: channel,
      expiresAt: now + DISCORD_CHANNEL_CACHE_TTL_MS,
    });
    return channel;
  } catch {
    return null;
  }
}

// Project resolution is handled in the Go binary; this module focuses on session parsing,
// Discord channel metadata, and tag normalisation.
