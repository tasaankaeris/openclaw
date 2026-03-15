import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk";
import {
  assertDmChannel,
  discordFetch,
  formatDiscordError,
  fetchDiscordChannel,
  normalizeReactionEmoji,
  postAttachmentMessage,
  resolveDiscordBotToken,
  safeJson,
} from "../src/discord-thread-helpers";
import { DISCORD_API_BASE, loadAttachmentPayload, requireConfig } from "./shared";

export function createDiscordDmSendTool(ctx: OpenClawPluginToolContext): AnyAgentTool {
  return {
    name: "discord-dm-send",
    label: "Discord DM Send",
    description: "Send a direct message to a specific Discord user id.",
    parameters: {
      type: "object",
      properties: {
        accountId: {
          type: "string",
          description:
            "Discord account id to send from (e.g. kaylee, nexus). This is required.",
        },
        userId: {
          type: "string",
          description:
            "Numeric Discord user id (e.g. 1469619426792837130) to DM.",
        },
        content: {
          type: "string",
          description: "Message text to send in the DM.",
        },
        replyToMessageId: {
          type: "string",
          description:
            "Optional message id in the DM channel to reply to using Discord's reply mechanics.",
        },
      },
      required: ["accountId", "userId", "content"],
      additionalProperties: false,
    },
    async execute(_toolCallId, rawArgs) {
      // DM tools allow any channel (webchat, CLI, etc.); explicit accountId+userId.
      const cfg = requireConfig(ctx.config);
      const args = rawArgs as Record<string, unknown>;
      const accountId = readStringParam(args, "accountId", { required: true });
      const userId = readStringParam(args, "userId", { required: true });
      const content = readStringParam(args, "content", { required: true });
      const replyToMessageId = readStringParam(args, "replyToMessageId");

      const token = resolveDiscordBotToken({ cfg, accountId });

      // Create (or reuse) a DM channel with this user.
      const dmRes = await discordFetch(
        token,
        `${DISCORD_API_BASE}/users/@me/channels`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ recipient_id: userId }),
        },
      );
      if (!dmRes.ok) {
        const body = await dmRes.text();
        throw new Error(
          formatDiscordError("DM channel create", dmRes.status, body.slice(0, 500)),
        );
      }
      const dmChannel = await safeJson<{ id: string }>(dmRes, "DM channel");
      if (typeof dmChannel.id !== "string") {
        throw new Error("Discord DM channel response missing id.");
      }
      const channelId = dmChannel.id;

      const body: Record<string, unknown> = {
        content,
        allowed_mentions: { parse: ["users"], replied_user: false },
      };
      if (replyToMessageId) {
        body.message_reference = {
          message_id: replyToMessageId,
        };
      }

      const sendRes = await discordFetch(
        token,
        `${DISCORD_API_BASE}/channels/${channelId}/messages`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );
      if (!sendRes.ok) {
        const body = await sendRes.text();
        throw new Error(
          formatDiscordError("DM send", sendRes.status, body.slice(0, 500)),
        );
      }
      const message = await safeJson<{ id: string }>(sendRes, "DM send");
      if (typeof message.id !== "string") {
        throw new Error("Discord DM send response missing id.");
      }
      ctx.logger?.debug?.("discord-dm-send", { channelId, userId, messageId: message.id });
      return jsonResult({
        ok: true,
        channelId,
        userId,
        messageId: message.id,
      });
    },
  };
}

export function createDiscordDmReactTool(ctx: OpenClawPluginToolContext): AnyAgentTool {
  return {
    name: "discord-dm-react",
    label: "Discord DM React",
    description: "React to a message in a Discord DM channel.",
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
            "Discord DM channel id where the message lives. Prefer using ids from previous discord-dm-send results.",
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
      // DM tools allow any channel (webchat, CLI, etc.); explicit accountId+channelId.
      const cfg = requireConfig(ctx.config);
      const args = rawArgs as Record<string, unknown>;
      const accountId = readStringParam(args, "accountId", { required: true });
      const channelId = readStringParam(args, "channelId", { required: true });
      const messageId = readStringParam(args, "messageId", { required: true });
      const emoji = readStringParam(args, "emoji", { required: true });

      const token = resolveDiscordBotToken({ cfg, accountId });

      const channel = await fetchDiscordChannel({ token, channelId });
      assertDmChannel(channel);

      const emojiEncoded = normalizeReactionEmoji(emoji);
      const url = `${DISCORD_API_BASE}/channels/${channelId}/messages/${messageId}/reactions/${emojiEncoded}/@me`;

      const res = await discordFetch(token, url, {
        method: "PUT",
        headers: {},
      });
      if (!res.ok && res.status !== 204) {
        const body = await res.text();
        throw new Error(
          formatDiscordError("DM react", res.status, body.slice(0, 500)),
        );
      }
      return jsonResult({ ok: true, channelId, messageId, emoji });
    },
  };
}

export function createDiscordDmAttachTool(ctx: OpenClawPluginToolContext): AnyAgentTool {
  return {
    name: "discord-dm-attach",
    label: "Discord DM Attach",
    description: "Attach a file into a Discord DM channel, with an optional caption.",
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
            "Discord DM channel id to post in. Prefer using ids from previous discord-dm-send results.",
        },
        filePath: {
          type: "string",
          description:
            "Path relative to your workspace (e.g. tmp/results.md) or an absolute path under your workspace root. Resolved using the runtime workspace; for sandboxed agents the runtime must supply the correct workspace. Base64/data URLs not supported. If you get ENOENT, try the default account or ensure files are in your agent workspace.",
        },
        filename: {
          type: "string",
          description: "Optional display name for the attachment.",
        },
        caption: {
          type: "string",
          description: "Optional short caption to include with the attachment.",
        },
      },
      required: ["accountId", "channelId", "filePath"],
      additionalProperties: false,
    },
    async execute(_toolCallId, rawArgs) {
      // DM tools allow any channel (webchat, CLI, etc.); explicit accountId+channelId.
      const cfg = requireConfig(ctx.config);
      const args = rawArgs as Record<string, unknown>;
      const accountId = readStringParam(args, "accountId", { required: true });
      const channelId = readStringParam(args, "channelId", { required: true });
      const filePath = readStringParam(args, "filePath", { required: true });
      const filename = readStringParam(args, "filename");
      const caption = readStringParam(args, "caption");

      const token = resolveDiscordBotToken({ cfg, accountId });

      const channel = await fetchDiscordChannel({ token, channelId });
      assertDmChannel(channel);

      const form = await loadAttachmentPayload({
        cfg,
        accountId,
        filePath,
        filename,
        caption,
        workspaceDir: ctx.workspaceDir,
        sandboxed: ctx.sandboxed,
        agentId: ctx.agentId, // runtime sets this to the agent that is running the tool
      });
      const result = await postAttachmentMessage({ token, channelId, form });
      ctx.logger?.debug?.("discord-dm-attach", { channelId, messageId: result.id });
      return jsonResult({
        ok: true,
        channelId,
        messageId: result.id,
      });
    },
  };
}
