/**
 * Discord thread tools plugin
 *
 * Design goals
 * ------------
 * - Provide intentful, Discord‑specific tools so agents do not have to use the
 *   very general `message` tool for common thread workflows.
 * - Keep Pi / session / tool plumbing entirely in core: these tools are
 *   registered as normal agent tools and rely on the existing Pi runtime for
 *   transcripts, compaction, hooks, and policies.
 * - Avoid changing the public `openclaw/plugin-sdk` surface; this plugin only
 *   consumes SDK exports that are already part of the stable contract.
 *
 * Supported intents (threads)
 * ---------------------------
 * - `discord-thread-create`: create a new thread under one of a small set of
 *   known parent channels (general/system/ops) and send an initial message.
 * - `discord-thread-send`: send (optionally reply) into an existing thread,
 *   identified only by its thread channel id.
 * - `discord-thread-react`: react to a specific message in a thread.
 * - `discord-thread-attach`: send a file attachment into a thread, with an
 *   optional caption, from workspace/container paths.
 * - `discord-channel-react`: react to a message in any channel (guild channel,
 *   thread, or DM); channel must be in the configured guild when applicable.
 *
 * Supported intents (DMs)
 * -----------------------
 * - `discord-dm-send`: send a direct message to a specific Discord user id.
 * - `discord-dm-react`: react to a message in a DM channel.
 * - `discord-dm-attach`: send a file attachment in a DM channel, with an
 *   optional caption, from workspace/container paths.
 *
 * Why HTTP is implemented here instead of using `message`
 * -------------------------------------------------------
 * - Core `message` uses internal helpers (`runMessageAction`, outbound
 *   delivery/session routing, sandbox media hydration) that are *not* exposed
 *   in `openclaw/plugin-sdk`. A tool plugin cannot safely call those without
 *   depending on non‑public internals.
 * - To keep this extension compatible with upstream OpenClaw releases, all
 *   Discord I/O is done against Discord's REST API using only SDK‑exported
 *   helpers:
 *     - `resolveDiscordAccount` (via `resolveDiscordBotToken`) to get tokens.
 *     - `fetchWithSsrFGuard` / `discordFetch` for HTTP with SSRF protections.
 *     - `loadWebMedia` + `resolveChannelMediaMaxBytes` to read and bound
 *       attachment payloads from the local filesystem.
 *
 * Required accountId and thread‑only routing
 * ------------------------------------------
 * - `accountId` is required on all tools. In multi‑account setups, relying on
 *   `resolveDefaultDiscordAccountId` has proven ambiguous; requiring
 *   `accountId` makes routing explicit and mirrors how `message` prefers an
 *   explicit account override.
 * - Tools do *not* take a `channel`/`to` parameter. All routing is by thread
 *   channel id (`threadId`) plus a constrained `parentChannel` enum for
 *   creation. This removes the need for models to remember or guess parent
   *   channel ids and prevents accidental sends to the wrong surface.
 * - `assertThreadBelongsToAllowedParent` performs a defensive check that a
 *   given `threadId` is in the expected guild and under one of a small,
 *   hard‑coded parent channel set. If this fails, the tool throws rather than
 *   risk sending to an unexpected location.
 *
 * What is *not* replicated from core `message`
 * --------------------------------------------
 * - Outbound gateway routing (`runMessageAction` + gateway clients): this
 *   plugin sends directly from the agent process to Discord. If core later
 *   exposes a stable "send via gateway" helper in the SDK, these tools could
 *   be migrated to use it.
 * - Outbound‑session routing (`ensureOutboundSessionEntry` and friends): Pi
 *   transcripts still contain full `tool_use`/`tool_result` history for these
 *   tools, but no additional outbound‑session records are written. For
 *   thread‑centric workflows triggered by inbound Discord messages, Pi
 *   sessions are the primary source of truth.
 *
 * Future SDK surface that would simplify this plugin
 * --------------------------------------------------
 * - A stable, SDK‑exported helper that wraps `runMessageAction` for
 *   channel‑specific sends, e.g. `sendDiscordThreadMessage` /
 *   `sendDiscordThreadAttachment`, that:
 *     - Accepts `{ cfg, accountId, threadId, ... }`.
 *     - Handles sandbox/media hydration and respect per‑channel limits.
 *     - Uses the gateway/outbound/session routing pipeline internally.
 * - Until such helpers exist, this plugin keeps its own minimal HTTP and
 *   attachment logic inside the extension, while relying on the SDK for
 *   config, tokens, and media loading.
 */
import type {
  AnyAgentTool,
  OpenClawConfig,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk";
import {
  jsonResult,
  loadWebMedia,
  readStringParam,
  resolveChannelMediaMaxBytes,
} from "openclaw/plugin-sdk";
import fs from "node:fs/promises";
import path from "node:path";
import {
  assertDmChannel,
  assertThreadBelongsToAllowedParent,
  discordFetch,
  fetchDiscordChannel,
  formatDiscordError,
  normalizeReactionEmoji,
  postAttachmentMessage,
  resolveDiscordBotToken,
  safeJson,
  validateAttachmentFilePath,
} from "./src/discord-thread-helpers";

const DISCORD_API_BASE = "https://discord.com/api/v10";

function ensureDiscordContext(ctx: OpenClawPluginToolContext): void {
  const channel = (ctx.messageChannel ?? "").trim().toLowerCase();
  if (channel !== "discord") {
    throw new Error(
      `discord-thread tools are only allowed in Discord sessions (got channel=${channel || "unknown"}).`,
    );
  }
}

function requireConfig(cfg?: OpenClawConfig): OpenClawConfig {
  if (!cfg) {
    throw new Error("OpenClaw config is not available.");
  }
  return cfg;
}

type DiscordThreadToolsConfig = {
  guildId?: string;
  parentChannels?: Record<string, string>;
};

const DEFAULT_DISCORD_GUILD_ID = "1469620697293652180";
const DEFAULT_DISCORD_PARENT_CHANNELS: Record<string, string> = {
  general: "1469620697935511564",
  system: "1469628926782341291",
  ops: "1469659372492689531",
} as const;

/** Fallback cap for attachments when no agent/channel limit is set (Discord non-nitro 8MB). */
const DISCORD_ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;

type ParentChannelKey = keyof typeof DEFAULT_DISCORD_PARENT_CHANNELS;

async function loadAttachmentPayload(params: {
  cfg: OpenClawConfig;
  accountId: string;
  filePath: string;
  filename?: string;
  caption?: string;
  /** Agent workspace root (OpenClaw workspace + agent workspace name). When set, paths are resolved relative to it. */
  workspaceDir?: string;
  /** When true, agent sees workspace at /workspace; map /workspace/... to workspaceDir. When false, paths are relative to workspaceDir. */
  sandboxed?: boolean;
}): Promise<FormData> {
  const safePath = validateAttachmentFilePath(params.filePath, {
    workspaceRoot: params.workspaceDir,
    sandboxed: params.sandboxed,
  });
  const maxBytes =
    resolveChannelMediaMaxBytes({
      cfg: params.cfg,
      accountId: params.accountId,
      resolveChannelLimitMb: () => undefined,
    }) ?? DISCORD_ATTACHMENT_MAX_BYTES;
  let media: Awaited<ReturnType<typeof loadWebMedia>>;
  try {
    media = await loadWebMedia(safePath, {
      maxBytes,
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

function createDiscordThreadCreateTool(
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

function createDiscordThreadSendTool(
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
          description: "Discord thread/channel ID where the message will be posted.",
        },
        content: {
          type: "string",
          description: "Message text to post into the thread.",
        },
        mentionAgentId: {
          type: "string",
          description:
            "Optional numeric Discord ID to mention once as <@ID>. Do not include mentions directly in content.",
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
      const contentRaw = readStringParam(args, "content", { required: true });
      const mentionAgentId = readStringParam(args, "mentionAgentId");
      const replyToMessageId = readStringParam(args, "replyToMessageId");

      if (contentRaw.includes("<@") && !mentionAgentId) {
        throw new Error(
          "Do not include raw Discord mentions in content; use mentionAgentId instead.",
        );
      }

      const token = resolveDiscordBotToken({ cfg, accountId });

      const guildId = pluginCfg.guildId ?? DEFAULT_DISCORD_GUILD_ID;
      const parentChannels = pluginCfg.parentChannels ?? DEFAULT_DISCORD_PARENT_CHANNELS;
      await assertThreadBelongsToAllowedParent({
        token,
        threadId,
        allowedGuildId: guildId,
        allowedParentChannelIds: Object.values(parentChannels),
      });

      let content = contentRaw;
      if (mentionAgentId && !content.includes("<@")) {
        content = `${content} <@${mentionAgentId}>`;
      }

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
        id: message.id,
      });
    },
  };
}

function createDiscordThreadReactTool(
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
          description: "Discord thread/channel ID where the message lives.",
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

function createDiscordThreadAttachTool(
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
            "Discord account id to send from (e.g. data, kaylee). This is required.",
        },
        threadId: {
          type: "string",
          description: "Discord thread/channel ID to post in.",
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
      });
      const result = await postAttachmentMessage({ token, channelId: threadId, form });
      ctx.logger?.debug?.("discord-thread-attach", { threadId, messageId: result.id });
      return jsonResult({
        ok: true,
        threadId,
        id: result.id,
      });
    },
  };
}

function createDiscordDmSendTool(ctx: OpenClawPluginToolContext): AnyAgentTool {
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
      },
      required: ["accountId", "userId", "content"],
      additionalProperties: false,
    },
    async execute(_toolCallId, rawArgs) {
      ensureDiscordContext(ctx);
      const cfg = requireConfig(ctx.config);
      const args = rawArgs as Record<string, unknown>;
      const accountId = readStringParam(args, "accountId", { required: true });
      const userId = readStringParam(args, "userId", { required: true });
      const content = readStringParam(args, "content", { required: true });

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

      const sendRes = await discordFetch(
        token,
        `${DISCORD_API_BASE}/channels/${channelId}/messages`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            content,
            allowed_mentions: { parse: ["users"], replied_user: false },
          }),
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
        id: message.id,
      });
    },
  };
}

function createDiscordChannelReactTool(
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

function createDiscordDmReactTool(ctx: OpenClawPluginToolContext): AnyAgentTool {
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
      ensureDiscordContext(ctx);
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

function createDiscordDmAttachTool(ctx: OpenClawPluginToolContext): AnyAgentTool {
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
            "Discord account id to send from (e.g. data, kaylee). This is required.",
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
      ensureDiscordContext(ctx);
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
      });
      const result = await postAttachmentMessage({ token, channelId, form });
      ctx.logger?.debug?.("discord-dm-attach", { channelId, messageId: result.id });
      return jsonResult({
        ok: true,
        channelId,
        id: result.id,
      });
    },
  };
}

const plugin = {
  id: "discord-thread-tools",
  name: "Discord Thread Tools",
  description:
    "Intentful Discord thread and DM tools (create/send/react/attach).",
  configSchema: {},
  register(api: OpenClawPluginApi) {
    const pluginCfg = (api.pluginConfig ?? {}) as DiscordThreadToolsConfig;
    api.registerTool(
      (ctx) => [
        createDiscordThreadCreateTool(ctx, pluginCfg),
        createDiscordThreadSendTool(ctx, pluginCfg),
        createDiscordThreadReactTool(ctx, pluginCfg),
        createDiscordThreadAttachTool(ctx, pluginCfg),
        createDiscordChannelReactTool(ctx, pluginCfg),
        createDiscordDmSendTool(ctx),
        createDiscordDmReactTool(ctx),
        createDiscordDmAttachTool(ctx),
      ],
      { optional: false },
    );
  },
};

export default plugin;
