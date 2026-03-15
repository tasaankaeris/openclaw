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
 * - `discord-thread-read`: read a thread window with neutral pagination
 *   primitives (`earlier`/`later`) and optional detail expansion flags.
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
 * - `assertThreadBelongsToAllowedParent` ensures the target is a Discord thread
 *   (channel type 11 or 12) and, when configured, that it is in the expected
 *   guild and under an allowed parent. Thread-send/attach/react are threads-only;
 *   no extra arguments—we reject if the given channel id is not a thread.
 * - In non‑agent contexts (e.g. tools catalog, HTTP tool invoke), the runtime
 *   may still pass a plugin tool context with `agentId` set to a default; it may
 *   not correspond to an active agent session. In a typical agent + Discord run,
 *   `ctx.agentId` is the id of the agent executing the tool (set by the runtime).
 * - The read tool is objective-neutral: it returns factual message data plus
 *   navigation actions (`readEarlierRequest`, `readLaterRequest`,
 *   `aroundMessageTemplate`). It does not inject objective-specific instructions.
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
 *
 * Read tool contract notes
 * ------------------------
 * - `discord-thread-read` is intentionally objective-neutral. It returns facts
 *   and navigation primitives, but it does not infer or inject user intent
 *   (for example, "you should now search for attachments").
 * - External navigation uses `earlier` / `later` terminology because "next"
 *   and "previous" are perspective-dependent for LLM callers.
 * - Cursor replay is anchor-relative for a live thread; `later` reads may
 *   include newly arrived messages by design.
 * - Returned `nextActions` contain full executable request objects with
 *   explicit effective optional values so callers can replay without hidden
 *   defaults.
 * - Attachment reads are opt-in via `includeAttachments`. When enabled, the
 *   tool returns metadata plus hydration attempts to local `media/inbound/*`
 *   paths (with per-attachment failure flags instead of verbose errors).
 * - `includeSystem=false` is a presentation filter only; raw-window anchors and
 *   counters (`rawCount`, `filteredOutCount`, and optional `filtered`) remain
 *   grounded in the fetched Discord window for stable continuation behavior.
 * - Around reads (`aroundMessageId`) are a neutral way to center context on a
 *   message. Attachment details are available by combining around reads with
 *   `includeAttachments=true` when callers explicitly choose that path.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { DiscordThreadToolsConfig } from "./tools/shared";
import {
  createDiscordThreadCreateTool,
  createDiscordThreadSendTool,
  createDiscordThreadReactTool,
  createDiscordThreadAttachTool,
  createDiscordThreadReadTool,
} from "./tools/thread-tools";
import {
  createDiscordDmSendTool,
  createDiscordDmReactTool,
  createDiscordDmAttachTool,
} from "./tools/dm-tools";
import { createDiscordChannelReactTool } from "./tools/channel-tools";

const plugin = {
  id: "discord-thread-tools",
  name: "Discord Thread Tools",
  description:
    "Intentful Discord thread and DM tools (create/send/react/attach/read).",
  configSchema: {},
  register(api: OpenClawPluginApi) {
    const pluginCfg = (api.pluginConfig ?? {}) as DiscordThreadToolsConfig;
    api.registerTool(
      (ctx) => [
        createDiscordThreadCreateTool(ctx, pluginCfg),
        createDiscordThreadSendTool(ctx, pluginCfg),
        createDiscordThreadReactTool(ctx, pluginCfg),
        createDiscordThreadAttachTool(ctx, pluginCfg),
        createDiscordThreadReadTool(ctx, pluginCfg),
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
