/**
 * Discord thread read orchestration: fetch messages, project, hydrate, paginate.
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
import {
  discordFetch,
  formatDiscordError,
  safeJson,
} from "./api-client";
import { DISCORD_API_BASE } from "./api-client";
import { assertThreadBelongsToAllowedParent } from "./channel-validation";
import {
  decodeThreadReadCursor,
  encodeThreadReadCursor,
  type ThreadReadCursorPayload,
} from "./cursor-pagination";
import {
  attachmentMessageIdsFromRaw,
  normalizeMessagesOldestToNewest,
  projectMessage,
  type DiscordRawMessage,
  type DiscordThreadReadDirection,
  type DiscordThreadReadMessage,
  type DiscordThreadReadParams,
} from "./message-projection";

export type { DiscordThreadReadDirection, DiscordThreadReadParams };
import {
  hydrateProjectedMessageAttachments,
  type ToolLogger,
} from "./attachment-hydration";

export type { ToolLogger };

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
