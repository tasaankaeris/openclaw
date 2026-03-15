import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk";
import {
  discordFetch,
  fetchDiscordChannel,
  formatDiscordError,
  normalizeReactionEmoji,
  resolveDiscordBotToken,
} from "../src/discord-thread-helpers";
import type { DiscordThreadToolsConfig } from "./shared";
import {
  DEFAULT_DISCORD_GUILD_ID,
  DISCORD_API_BASE,
  ensureDiscordContext,
  requireConfig,
} from "./shared";

export function createDiscordChannelReactTool(
  ctx: OpenClawPluginToolContext,
  pluginCfg: DiscordThreadToolsConfig,
): AnyAgentTool {
  return {
    name: "discord-channel-react",
    label: "Discord Channel React",
    description:
      "React to a message in any Discord channel (guild text channel, thread, or DM). Use for channel or thread messages when you have the channel id.",
    parameters: {
      type: "object",
      properties: {
        accountId: {
          type: "string",
          description:
            "Discord account id to send from (e.g. kaylee, nexus). This is required.",
        },
        channelId: {
          type: "string",
          description:
            "Discord channel id where the message lives (text channel, thread, or DM).",
        },
        messageId: {
          type: "string",
          description: "Discord message ID to react to.",
        },
        emoji: {
          type: "string",
          description:
            "Unicode emoji (e.g. ✅, 👍) or custom guild emoji as <:name:id> or <a:name:id>.",
        },
      },
      required: ["accountId", "channelId", "messageId", "emoji"],
      additionalProperties: false,
    },
    async execute(_toolCallId, rawArgs) {
      ensureDiscordContext(ctx);
      const cfg = requireConfig(ctx.config);
      const args = rawArgs as Record<string, unknown>;
      const accountId = readStringParam(args, "accountId", { required: true });
      const channelId = readStringParam(args, "channelId", { required: true });
      const messageId = readStringParam(args, "messageId", { required: true });
      const emoji = readStringParam(args, "emoji", { required: true });

      const token = resolveDiscordBotToken({ cfg, accountId });

      const guildId = pluginCfg.guildId ?? DEFAULT_DISCORD_GUILD_ID;
      const channel = await fetchDiscordChannel({ token, channelId });
      if (channel.guild_id && channel.guild_id !== guildId) {
        throw new Error(
          `Channel ${channelId} is in guild ${channel.guild_id}, not the configured guild ${guildId}.`,
        );
      }

      const emojiEncoded = normalizeReactionEmoji(emoji);
      const url = `${DISCORD_API_BASE}/channels/${channelId}/messages/${messageId}/reactions/${emojiEncoded}/@me`;

      const res = await discordFetch(token, url, {
        method: "PUT",
        headers: {},
      });

      if (!res.ok && res.status !== 204) {
        const body = await res.text();
        throw new Error(
          formatDiscordError("channel react", res.status, body.slice(0, 500)),
        );
      }

      return jsonResult({ ok: true, channelId, messageId, emoji });
    },
  };
}
