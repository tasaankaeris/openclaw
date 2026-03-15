import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk";
import { jsonResult, readBooleanParam, readStringParam } from "openclaw/plugin-sdk";
import {
  assertThreadBelongsToAllowedParent,
  discordFetch,
  formatDiscordError,
  normalizeReactionEmoji,
  postAttachmentMessage,
  readThreadMessages,
  resolveDiscordBotToken,
  safeJson,
} from "../src/discord-thread-helpers";
import type { DiscordThreadToolsConfig, ParentChannelKey } from "./shared";
import {
  DEFAULT_DISCORD_GUILD_ID,
  DEFAULT_DISCORD_PARENT_CHANNELS,
  DISCORD_API_BASE,
  ensureDiscordContext,
  loadAttachmentPayload,
  readOptionalIntegerParam,
  requireConfig,
} from "./shared";

export function createDiscordThreadCreateTool(
  ctx: OpenClawPluginToolContext,
  pluginCfg: DiscordThreadToolsConfig,
): AnyAgentTool {
  return {
    name: "discord-thread-create",
    label: "Discord Thread Create",
    description:
      "Create a new Discord thread under a known parent channel (general, system, ops).",
    parameters: {
      type: "object",
      properties: {
        accountId: {
          type: "string",
          description:
            "Discord account id to send from (e.g. kaylee, nexus). This is required.",
        },
        parentChannel: {
          type: "string",
          enum: ["general", "system", "ops"],
          description:
            "Parent channel to create the thread under (general, system, or ops).",
        },
        threadName: {
          type: "string",
          description: "Name of the new thread (e.g. Task 2026-03-04).",
        },
        content: {
          type: "string",
          description:
            "Initial message content to post into the new thread.",
        },
      },
      required: ["accountId", "parentChannel", "threadName", "content"],
      additionalProperties: false,
    },
    async execute(_toolCallId, rawArgs) {
      ensureDiscordContext(ctx);
      const cfg = requireConfig(ctx.config);
      const args = rawArgs as Record<string, unknown>;
      const accountId = readStringParam(args, "accountId", { required: true });
      const parentChannel = readStringParam(args, "parentChannel", {
        required: true,
      }) as ParentChannelKey;
      const threadName = readStringParam(args, "threadName", {
        required: true,
      });
      const content = readStringParam(args, "content", {
        required: true,
      });

      const parentChannels = pluginCfg.parentChannels ?? DEFAULT_DISCORD_PARENT_CHANNELS;
      if (!Object.prototype.hasOwnProperty.call(parentChannels, parentChannel)) {
        throw new Error(
          `Invalid parentChannel "${parentChannel}". Expected one of: general, system, ops.`,
        );
      }
      const parentChannelId = parentChannels[parentChannel];

      const token = resolveDiscordBotToken({ cfg, accountId });

      const res = await discordFetch(
        token,
        `${DISCORD_API_BASE}/channels/${parentChannelId}/threads`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: threadName,
            type: 11, // public thread
            auto_archive_duration: 1440, // 24h, adjust as needed
            message: {
              content,
              allowed_mentions: { parse: ["users"], replied_user: false },
            },
          }),
        },
      );

      if (!res.ok) {
        const body = await res.text();
        throw new Error(
          formatDiscordError("thread create", res.status, body.slice(0, 500)),
        );
      }

      const thread = await safeJson<{ id: string }>(res, "thread create");
      if (typeof thread.id !== "string") {
        throw new Error("Discord thread create response missing id.");
      }
      ctx.logger?.debug?.("discord-thread-create", { threadId: thread.id });
      return jsonResult({
        ok: true,
        threadId: thread.id,
        parentChannelId,
      });
    },
  };
}

export function createDiscordThreadSendTool(
  ctx: OpenClawPluginToolContext,
  pluginCfg: DiscordThreadToolsConfig,
): AnyAgentTool {
  return {
    name: "discord-thread-send",
    label: "Discord Thread Send",
    description:
      "Send a message into a specific Discord thread. Never sends to the parent channel.",
    parameters: {
      type: "object",
      properties: {
        accountId: {
          type: "string",
          description:
            "Discord account id to send from (e.g. kaylee, nexus). This is required.",
        },
        threadId: {
          type: "string",
          description: "Discord thread ID where the message will be posted.",
        },
        content: {
          type: "string",
          description: "Message text to post into the thread.",
        },
        replyToMessageId: {
          type: "string",
          description:
            "Optional message id within the thread to reply to using Discord's reply mechanics.",
        },
      },
      required: ["accountId", "threadId", "content"],
      additionalProperties: false,
    },
    async execute(_toolCallId, rawArgs) {
      ensureDiscordContext(ctx);
      const cfg = requireConfig(ctx.config);
      const args = rawArgs as Record<string, unknown>;
      const accountId = readStringParam(args, "accountId", { required: true });
      const threadId = readStringParam(args, "threadId", { required: true });
      const content = readStringParam(args, "content", { required: true });
      const replyToMessageId = readStringParam(args, "replyToMessageId");

      const token = resolveDiscordBotToken({ cfg, accountId });

      const guildId = pluginCfg.guildId ?? DEFAULT_DISCORD_GUILD_ID;
      const parentChannels = pluginCfg.parentChannels ?? DEFAULT_DISCORD_PARENT_CHANNELS;
      await assertThreadBelongsToAllowedParent({
        token,
        threadId,
        allowedGuildId: guildId,
        allowedParentChannelIds: Object.values(parentChannels),
      });

      const body: Record<string, unknown> = {
        content,
        allowed_mentions: { parse: ["users"], replied_user: false },
      };
      if (replyToMessageId) {
        body.message_reference = {
          message_id: replyToMessageId,
        };
      }

      const res = await discordFetch(
        token,
        `${DISCORD_API_BASE}/channels/${threadId}/messages`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );

      if (!res.ok) {
        const respBody = await res.text();
        throw new Error(
          formatDiscordError("thread send", res.status, respBody.slice(0, 500)),
        );
      }

      const message = await safeJson<{ id: string }>(res, "thread send");
      if (typeof message.id !== "string") {
        throw new Error("Discord thread send response missing id.");
      }
      ctx.logger?.debug?.("discord-thread-send", { threadId, messageId: message.id });
      return jsonResult({
        ok: true,
        threadId,
        messageId: message.id,
      });
    },
  };
}

export function createDiscordThreadReactTool(
  ctx: OpenClawPluginToolContext,
  pluginCfg: DiscordThreadToolsConfig,
): AnyAgentTool {
  return {
    name: "discord-thread-react",
    label: "Discord Thread React",
    description: "React to a message in a Discord thread.",
    parameters: {
      type: "object",
      properties: {
        accountId: {
          type: "string",
          description:
            "Discord account id to send from (e.g. kaylee, nexus). This is required.",
        },
        threadId: {
          type: "string",
          description: "Discord thread ID where the message lives.",
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
      required: ["accountId", "threadId", "messageId", "emoji"],
      additionalProperties: false,
    },
    async execute(_toolCallId, rawArgs) {
      ensureDiscordContext(ctx);
      const cfg = requireConfig(ctx.config);
      const args = rawArgs as Record<string, unknown>;
      const accountId = readStringParam(args, "accountId", { required: true });
      const threadId = readStringParam(args, "threadId", { required: true });
      const messageId = readStringParam(args, "messageId", { required: true });
      const emoji = readStringParam(args, "emoji", { required: true });

      const token = resolveDiscordBotToken({ cfg, accountId });

      const guildId = pluginCfg.guildId ?? DEFAULT_DISCORD_GUILD_ID;
      const parentChannels = pluginCfg.parentChannels ?? DEFAULT_DISCORD_PARENT_CHANNELS;
      await assertThreadBelongsToAllowedParent({
        token,
        threadId,
        allowedGuildId: guildId,
        allowedParentChannelIds: Object.values(parentChannels),
      });

      const emojiEncoded = normalizeReactionEmoji(emoji);
      const url = `${DISCORD_API_BASE}/channels/${threadId}/messages/${messageId}/reactions/${emojiEncoded}/@me`;

      const res = await discordFetch(token, url, {
        method: "PUT",
        headers: {},
      });

      if (!res.ok && res.status !== 204) {
        const body = await res.text();
        throw new Error(
          formatDiscordError("thread react", res.status, body.slice(0, 500)),
        );
      }

      return jsonResult({ ok: true, threadId, messageId, emoji });
    },
  };
}

export function createDiscordThreadAttachTool(
  ctx: OpenClawPluginToolContext,
  pluginCfg: DiscordThreadToolsConfig,
): AnyAgentTool {
  return {
    name: "discord-thread-attach",
    label: "Discord Thread Attach",
    description: "Attach a file into a Discord thread, with an optional caption.",
    parameters: {
      type: "object",
      properties: {
        accountId: {
          type: "string",
          description:
            "Discord account id to send from (e.g. kaylee, nexus). This is required.",
        },
        threadId: {
          type: "string",
          description: "Discord thread ID to post in.",
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
      required: ["accountId", "threadId", "filePath"],
      additionalProperties: false,
    },
    async execute(_toolCallId, rawArgs) {
      ensureDiscordContext(ctx);
      const cfg = requireConfig(ctx.config);
      const args = rawArgs as Record<string, unknown>;
      const accountId = readStringParam(args, "accountId", { required: true });
      const threadId = readStringParam(args, "threadId", { required: true });
      const filePath = readStringParam(args, "filePath", { required: true });
      const filename = readStringParam(args, "filename");
      const caption = readStringParam(args, "caption");

      const token = resolveDiscordBotToken({ cfg, accountId });

      const guildId = pluginCfg.guildId ?? DEFAULT_DISCORD_GUILD_ID;
      const parentChannels = pluginCfg.parentChannels ?? DEFAULT_DISCORD_PARENT_CHANNELS;
      await assertThreadBelongsToAllowedParent({
        token,
        threadId,
        allowedGuildId: guildId,
        allowedParentChannelIds: Object.values(parentChannels),
      });

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
      const result = await postAttachmentMessage({ token, channelId: threadId, form });
      ctx.logger?.debug?.("discord-thread-attach", { threadId, messageId: result.id });
      return jsonResult({
        ok: true,
        threadId,
        messageId: result.id,
      });
    },
  };
}

export function createDiscordThreadReadTool(
  ctx: OpenClawPluginToolContext,
  pluginCfg: DiscordThreadToolsConfig,
): AnyAgentTool {
  return {
    name: "discord-thread-read",
    label: "Discord Thread Read",
    description:
      "Read messages from a Discord thread with neutral earlier/later pagination primitives.",
    parameters: {
      type: "object",
      properties: {
        accountId: {
          type: "string",
          description:
            "Discord account id to read from (e.g. kaylee, nexus). This is required.",
        },
        threadId: {
          type: "string",
          description: "Discord thread ID to read from.",
        },
        limit: {
          type: "integer",
          description: "Number of messages to read (1-100, default 30).",
        },
        cursor: {
          type: "string",
          description: "Opaque cursor from a previous discord-thread-read result.",
        },
        direction: {
          type: "string",
          enum: ["earlier", "later"],
          description:
            "Optional continuation direction override when cursor is present.",
        },
        aroundMessageId: {
          type: "string",
          description: "Optional message ID to center an around-read window.",
        },
        includeContent: {
          type: "boolean",
          description: "Include message content (default true).",
        },
        contentMaxChars: {
          type: "integer",
          description: "Maximum content characters per message (0-4000, default 2000).",
        },
        includeSystem: {
          type: "boolean",
          description: "Include system messages (default false).",
        },
        includeEmbeds: {
          type: "boolean",
          description: "Include compact embed metadata (default false).",
        },
        includeAttachments: {
          type: "boolean",
          description:
            "Include compact attachment metadata and hydrate attachments into local media/inbound paths (default false).",
        },
        forceReDownload: {
          type: "boolean",
          description:
            "When includeAttachments=true, bypass deterministic URL-hash cache and re-download attachments (default false).",
        },
      },
      required: ["accountId", "threadId"],
      additionalProperties: false,
    },
    async execute(_toolCallId, rawArgs) {
      ensureDiscordContext(ctx);
      const cfg = requireConfig(ctx.config);
      const args = rawArgs as Record<string, unknown>;
      const accountId = readStringParam(args, "accountId", { required: true });
      const threadId = readStringParam(args, "threadId", { required: true });
      const cursor = readStringParam(args, "cursor");
      const directionRaw = readStringParam(args, "direction");
      const aroundMessageId = readStringParam(args, "aroundMessageId");
      const limit = readOptionalIntegerParam(args, "limit");
      const includeContent = readBooleanParam(args, "includeContent") ?? true;
      const contentMaxChars = readOptionalIntegerParam(args, "contentMaxChars") ?? 2000;
      const includeSystem = readBooleanParam(args, "includeSystem") ?? false;
      const includeEmbeds = readBooleanParam(args, "includeEmbeds") ?? false;
      const includeAttachments = readBooleanParam(args, "includeAttachments") ?? false;
      const forceReDownload = readBooleanParam(args, "forceReDownload") ?? false;
      const effectiveLimit = limit ?? (includeAttachments ? 5 : undefined);

      if (limit != null && (limit < 1 || limit > 100)) {
        throw new Error(`limit must be between 1 and 100 (got ${limit}).`);
      }
      if (includeAttachments && effectiveLimit != null && effectiveLimit > 5) {
        throw new Error("When includeAttachments=true, limit must be <= 5.");
      }
      if (includeContent && (contentMaxChars < 0 || contentMaxChars > 4000)) {
        throw new Error(
          `contentMaxChars must be between 0 and 4000 (got ${contentMaxChars}).`,
        );
      }
      if (aroundMessageId && !/^\d{16,22}$/.test(aroundMessageId.trim())) {
        throw new Error("aroundMessageId must be a valid Discord message id.");
      }
      if (cursor && aroundMessageId) {
        throw new Error("cursor and aroundMessageId are mutually exclusive.");
      }
      if (directionRaw && !cursor) {
        throw new Error("direction requires cursor.");
      }
      if (directionRaw && aroundMessageId) {
        throw new Error("direction cannot be used with aroundMessageId.");
      }
      let direction: "earlier" | "later" | undefined;
      if (cursor && directionRaw) {
        if (directionRaw !== "earlier" && directionRaw !== "later") {
          throw new Error(`direction must be earlier or later (got ${directionRaw}).`);
        }
        direction = directionRaw;
      }

      const token = resolveDiscordBotToken({ cfg, accountId });
      const guildId = pluginCfg.guildId ?? DEFAULT_DISCORD_GUILD_ID;
      const parentChannels = pluginCfg.parentChannels ?? DEFAULT_DISCORD_PARENT_CHANNELS;

      const result = await readThreadMessages({
        token,
        allowedGuildId: guildId,
        allowedParentChannelIds: Object.values(parentChannels),
        read: {
          accountId,
          threadId,
          limit: effectiveLimit,
          cursor: cursor ?? undefined,
          direction,
          aroundMessageId: aroundMessageId ?? undefined,
          includeContent,
          contentMaxChars,
          includeSystem,
          includeEmbeds,
          includeAttachments,
          forceReDownload,
          workspaceDir: ctx.workspaceDir,
          sandboxed: ctx.sandboxed,
        },
        logger: ctx.logger,
      });

      return jsonResult(result);
    },
  };
}
