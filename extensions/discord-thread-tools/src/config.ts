/**
 * Configuration helpers for the discord-thread-tools extension.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { resolveDiscordAccount } from "openclaw/plugin-sdk";

export function resolveDiscordBotToken(params: {
  cfg?: OpenClawConfig;
  accountId: string;
}): string {
  const cfg = params.cfg;
  if (!cfg) {
    throw new Error("Discord config is not available.");
  }
  const account = resolveDiscordAccount({
    cfg,
    accountId: params.accountId,
  });
  if (!account.enabled || !account.token) {
    throw new Error(
      `Discord account "${account.accountId}" is not enabled or missing token.`,
    );
  }
  return account.token;
}

/**
 * Normalize emoji for Discord's reaction API URL. Strips variation selectors
 * (U+FE0E, U+FE0F) so unicode emoji match what Discord expects; converts custom
 * emoji <:name:id> / <a:name:id> to name:id. Returns URL-encoded string.
 */
export function normalizeReactionEmoji(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("emoji is required for reactions.");
  }
  const customMatch = trimmed.match(/^<a?:([^:>]+):(\d+)>$/);
  const identifier = customMatch
    ? `${customMatch[1]}:${customMatch[2]}`
    : trimmed.replace(/\uFE0E|\uFE0F/g, "");
  return encodeURIComponent(identifier);
}
