/**
 * Message projection: raw Discord messages to thread-read format, sorting, clipping.
 */
export type DiscordRawAuthor = {
  id?: string;
  username?: string;
};

export type DiscordRawAttachment = {
  id: string;
  filename?: string;
  content_type?: string;
  size?: number;
  url?: string;
  proxy_url?: string;
};

export type DiscordRawEmbed = {
  type?: string;
  title?: string;
  description?: string;
  url?: string;
};

export type DiscordRawMessage = {
  id: string;
  author?: DiscordRawAuthor;
  content?: string;
  timestamp?: string;
  type?: number;
  attachments?: DiscordRawAttachment[];
  embeds?: DiscordRawEmbed[];
};

export type DiscordThreadReadDirection = "earlier" | "later";

export type DiscordThreadReadParams = {
  accountId: string;
  threadId: string;
  limit?: number;
  cursor?: string;
  direction?: DiscordThreadReadDirection;
  aroundMessageId?: string;
  includeContent: boolean;
  contentMaxChars: number;
  includeSystem: boolean;
  includeEmbeds: boolean;
  includeAttachments: boolean;
  forceReDownload?: boolean;
  workspaceDir?: string;
  sandboxed?: boolean;
};

export type ProjectedEmbed = {
  type?: string;
  title?: string;
  description?: string;
  url?: string;
};

export type DiscordThreadReadMessage = {
  id: string;
  authorId: string;
  authorName: string;
  content?: string;
  createdAt: string;
  isSystem: boolean;
  hasAttachments: boolean;
  attachmentCount: number;
  hasEmbeds: boolean;
  embedCount: number;
  attachments?: ProjectedAttachment[];
  embeds?: ProjectedEmbed[];
};

/** ProjectedAttachment is used by message-projection and attachment-hydration. */
export type ProjectedAttachment = {
  id: string;
  filename?: string;
  contentType?: string;
  size?: number;
  url?: string;
  proxyUrl?: string;
  localPath?: string;
  hydrationFailure?: true;
};

function clipText(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }
  if (maxChars <= 0) {
    return "";
  }
  return `${content.slice(0, maxChars)} ...(truncated)`;
}

function messageIdComparatorAsc(a: string, b: string): number {
  try {
    const aBig = BigInt(a);
    const bBig = BigInt(b);
    if (aBig < bBig) {
      return -1;
    }
    if (aBig > bBig) {
      return 1;
    }
    return 0;
  } catch {
    return a.localeCompare(b);
  }
}

export function normalizeMessagesOldestToNewest(messages: DiscordRawMessage[]): DiscordRawMessage[] {
  return [...messages].sort((a, b) => messageIdComparatorAsc(a.id, b.id));
}

export function projectMessage(
  raw: DiscordRawMessage,
  params: DiscordThreadReadParams,
): DiscordThreadReadMessage | null {
  const type = raw.type ?? 0;
  const isSystem = type !== 0;
  if (!params.includeSystem && isSystem) {
    return null;
  }
  const attachments = Array.isArray(raw.attachments) ? raw.attachments : [];
  const embeds = Array.isArray(raw.embeds) ? raw.embeds : [];
  return {
    id: raw.id,
    authorId: raw.author?.id ?? "",
    authorName: raw.author?.username ?? "",
    content:
      params.includeContent && typeof raw.content === "string"
        ? clipText(raw.content, params.contentMaxChars)
        : undefined,
    createdAt: raw.timestamp ?? "",
    isSystem,
    hasAttachments: attachments.length > 0,
    attachmentCount: attachments.length,
    hasEmbeds: embeds.length > 0,
    embedCount: embeds.length,
    attachments: params.includeAttachments
      ? attachments.map((attachment) => ({
          id: attachment.id,
          filename: attachment.filename,
          contentType: attachment.content_type,
          size: attachment.size,
          url: attachment.url,
          proxyUrl: attachment.proxy_url,
        }))
      : undefined,
    embeds: params.includeEmbeds
      ? embeds.map((embed) => ({
          type: embed.type,
          title: embed.title,
          description: embed.description,
          url: embed.url,
        }))
      : undefined,
  };
}

export function attachmentMessageIdsFromRaw(rawMessages: DiscordRawMessage[]): string[] {
  const ids: string[] = [];
  for (let idx = rawMessages.length - 1; idx >= 0; idx -= 1) {
    const msg = rawMessages[idx];
    if (Array.isArray(msg!.attachments) && msg!.attachments!.length > 0) {
      ids.push(msg!.id);
    }
  }
  return ids;
}
