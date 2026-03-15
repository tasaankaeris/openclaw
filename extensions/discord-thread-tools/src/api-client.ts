/**
 * Discord API client: fetch with retry, rate-limit handling, and error formatting.
 */
export const DISCORD_API_BASE = "https://discord.com/api/v10";
export const RATE_LIMIT_MAX_RETRIES = 3;
export const RATE_LIMIT_MAX_DELAY_MS = 10_000;
export const RETRYABLE_HTTP_STATUSES = new Set([429, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseRetryAfterMs(retryAfter: string | null, maxDelayMs: number): number | undefined {
  if (!retryAfter) {
    return undefined;
  }
  const seconds = Number.parseFloat(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.ceil(seconds * 1000), maxDelayMs);
  }
  const asDate = Date.parse(retryAfter);
  if (Number.isFinite(asDate)) {
    const delayMs = asDate - Date.now();
    if (delayMs > 0) {
      return Math.min(delayMs, maxDelayMs);
    }
  }
  return undefined;
}

function resolveRetryDelayMs(params: {
  attempt: number;
  retryAfter: string | null;
  maxDelayMs: number;
}): number {
  const fromHeader = parseRetryAfterMs(params.retryAfter, params.maxDelayMs);
  if (fromHeader != null) {
    return fromHeader;
  }
  const exp = Math.min(500 * Math.pow(2, params.attempt), params.maxDelayMs);
  return Math.max(250, Math.trunc(exp));
}

export function isTransientNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const candidateCodes = [
    (err as { code?: unknown }).code,
    (err as { cause?: { code?: unknown } }).cause?.code,
  ]
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.toUpperCase());
  const knownCodes = new Set([
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "ENOTFOUND",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_SOCKET",
    "UND_ERR_CONNECT_ERROR",
  ]);
  if (candidateCodes.some((code) => knownCodes.has(code))) {
    return true;
  }
  return /(timed out|fetch failed|network|socket hang up|connection reset|temporary failure|dns)/i.test(
    err.message,
  );
}

export async function fetchWithRetry(params: {
  url: string;
  init: RequestInit & { method: string };
  maxRetries: number;
  maxDelayMs: number;
  retryableStatuses?: Set<number>;
  retryNetworkErrors?: boolean;
}): Promise<Response> {
  let lastResponse: Response | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt <= params.maxRetries; attempt += 1) {
    try {
      const res = await fetch(params.url, params.init);
      if (!(params.retryableStatuses ?? RETRYABLE_HTTP_STATUSES).has(res.status)) {
        return res;
      }
      lastResponse = res;
      if (attempt === params.maxRetries) {
        return res;
      }
      await sleep(
        resolveRetryDelayMs({
          attempt,
          retryAfter: res.headers.get("Retry-After"),
          maxDelayMs: params.maxDelayMs,
        }),
      );
      continue;
    } catch (err) {
      lastError = err;
      if (!params.retryNetworkErrors || !isTransientNetworkError(err) || attempt === params.maxRetries) {
        throw err;
      }
      await sleep(
        resolveRetryDelayMs({
          attempt,
          retryAfter: null,
          maxDelayMs: params.maxDelayMs,
        }),
      );
    }
  }
  if (lastResponse) {
    return lastResponse;
  }
  throw new Error(
    `request failed: ${
      lastError instanceof Error ? lastError.message : String(lastError ?? "unknown error")
    }`,
  );
}

export async function discordFetch(
  token: string,
  url: string,
  init: RequestInit & { method: string },
): Promise<Response> {
  const method = (init.method || "GET").toUpperCase();
  const isIdempotentMethod = method === "GET" || method === "HEAD";
  const retryableStatuses = isIdempotentMethod ? RETRYABLE_HTTP_STATUSES : new Set([429]);
  return await fetchWithRetry({
    url,
    init: {
      ...init,
      headers: {
        Authorization: `Bot ${token}`,
        ...(init.headers ?? {}),
      },
      method,
    },
    maxRetries: RATE_LIMIT_MAX_RETRIES,
    maxDelayMs: RATE_LIMIT_MAX_DELAY_MS,
    retryableStatuses,
    retryNetworkErrors: isIdempotentMethod,
  });
}

export function formatDiscordError(
  operation: string,
  status: number,
  bodySnippet: string,
): string {
  return `Discord ${operation} failed (${status}): ${bodySnippet || "<no body>"}`;
}

export async function safeJson<T>(res: Response, context: string): Promise<T> {
  let data: unknown;
  try {
    data = await res.json();
  } catch (err) {
    throw new Error(`Failed to parse Discord ${context} response: ${String(err)}`);
  }
  if (data === null || typeof data !== "object") {
    throw new Error(`Discord ${context} response is not an object.`);
  }
  return data as T;
}

export async function postAttachmentMessage(params: {
  token: string;
  channelId: string;
  form: FormData;
}): Promise<{ id: string }> {
  const res = await discordFetch(
    params.token,
    `${DISCORD_API_BASE}/channels/${params.channelId}/messages`,
    { method: "POST", body: params.form as unknown as BodyInit },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(formatDiscordError("attach", res.status, body.slice(0, 500)));
  }
  const data = await safeJson<{ id: string }>(res, "message");
  if (typeof data.id !== "string") {
    throw new Error("Discord message response missing id.");
  }
  return data;
}
