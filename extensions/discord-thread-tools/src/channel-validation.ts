/**
 * Discord channel validation: fetch channel, assert thread/DM, snowflake checks.
 */
import {
  discordFetch,
  formatDiscordError,
  safeJson,
} from "./api-client";
import { DISCORD_API_BASE } from "./api-client";

export type DiscordChannel = {
  id: string;
  type: number;
  guild_id?: string;
  parent_id?: string;
};

/** Discord channel type: 1 = DM, 3 = group DM. */
export const DISCORD_CHANNEL_TYPE_DM = 1;
export const DISCORD_CHANNEL_TYPE_GROUP_DM = 3;

/** Discord thread channel types: 11 = public thread, 12 = private thread. */
export const DISCORD_CHANNEL_TYPE_PUBLIC_THREAD = 11;
export const DISCORD_CHANNEL_TYPE_PRIVATE_THREAD = 12;

const DISCORD_THREAD_TYPES = [DISCORD_CHANNEL_TYPE_PUBLIC_THREAD, DISCORD_CHANNEL_TYPE_PRIVATE_THREAD];

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
