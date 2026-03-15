/**
 * Cursor encoding/decoding for Discord thread read pagination.
 */
import { isDiscordSnowflake } from "./channel-validation";

export type ThreadReadCursorPayload = {
  v: 1;
  threadId: string;
  dir: "earlier" | "later";
  anchorFirstMessageId: string;
  anchorLastMessageId: string;
  limit: number;
  snapshotNewestMessageId?: string;
  issuedAt?: number;
};

export function encodeThreadReadCursor(payload: ThreadReadCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeThreadReadCursor(rawCursor: string): ThreadReadCursorPayload {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(rawCursor, "base64url").toString("utf8"));
  } catch (err) {
    throw new Error(`Invalid cursor format: ${String(err)}`);
  }
  if (!decoded || typeof decoded !== "object") {
    throw new Error("Invalid cursor payload.");
  }
  const cursor = decoded as Partial<ThreadReadCursorPayload>;
  if (cursor.v !== 1) {
    throw new Error(`Unsupported cursor version: ${String(cursor.v)}`);
  }
  if (typeof cursor.threadId !== "string" || !isDiscordSnowflake(cursor.threadId)) {
    throw new Error("Cursor missing valid threadId.");
  }
  if (cursor.dir !== "earlier" && cursor.dir !== "later") {
    throw new Error("Cursor missing valid dir.");
  }
  if (
    typeof cursor.anchorFirstMessageId !== "string" ||
    !isDiscordSnowflake(cursor.anchorFirstMessageId)
  ) {
    throw new Error("Cursor missing valid anchorFirstMessageId.");
  }
  if (
    typeof cursor.anchorLastMessageId !== "string" ||
    !isDiscordSnowflake(cursor.anchorLastMessageId)
  ) {
    throw new Error("Cursor missing valid anchorLastMessageId.");
  }
  if (typeof cursor.limit !== "number" || !Number.isFinite(cursor.limit)) {
    throw new Error("Cursor missing valid limit.");
  }
  return cursor as ThreadReadCursorPayload;
}
