/**
 * Discord thread helper primitives used by the discord-thread-tools extension.
 *
 * This file re-exports all helpers from focused modules for backward compatibility.
 */

// Config helpers
export { resolveDiscordBotToken, normalizeReactionEmoji } from "./config";

// API client
export {
  discordFetch,
  fetchWithRetry,
  formatDiscordError,
  safeJson,
  postAttachmentMessage,
  DISCORD_API_BASE,
} from "./api-client";

// Channel validation
export {
  fetchDiscordChannel,
  assertThreadBelongsToAllowedParent,
  assertDmChannel,
  isDiscordSnowflake,
  DISCORD_CHANNEL_TYPE_DM,
  DISCORD_CHANNEL_TYPE_GROUP_DM,
  DISCORD_CHANNEL_TYPE_PUBLIC_THREAD,
  DISCORD_CHANNEL_TYPE_PRIVATE_THREAD,
  type DiscordChannel,
} from "./channel-validation";

// Cursor pagination
export {
  encodeThreadReadCursor,
  type ThreadReadCursorPayload,
} from "./cursor-pagination";

// Message projection
export {
  type DiscordRawMessage,
  type DiscordThreadReadMessage,
} from "./message-projection";

// Attachment hydration
export {
  validateAttachmentFilePath,
  resolveSandboxContainerWorkdirFromConfig,
  canonicalUrlToGuid,
  URL_NAMESPACE_UUID,
  type ValidateAttachmentPathOptions,
} from "./attachment-hydration";

// Thread reader
export {
  readThreadMessages,
  type DiscordThreadReadParams,
  type DiscordThreadReadDirection,
  type DiscordThreadReadResult,
} from "./thread-reader";
