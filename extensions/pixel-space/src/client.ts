/**
 * HTTP client for the pixel-agents sidecar API.
 * Uses fetchWithSsrFGuard with allowPrivateNetwork for local/Docker sidecar.
 */
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk";

export type PixelSpaceClientConfig = {
  baseUrl: string;
  apiKey?: string;
  agentId?: string;
  workspaceDir?: string;
};

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function buildHeaders(config: PixelSpaceClientConfig): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.agentId) {
    headers["X-Agent-ID"] = config.agentId;
  }
  const key = config.apiKey ?? process.env.OPENCLAW_PIXEL_AGENTS_API_KEY ?? process.env.PIXEL_AGENTS_API_KEY;
  if (key) {
    headers["X-API-Key"] = key;
  }
  return headers;
}

export async function pixelApiFetch(
  config: PixelSpaceClientConfig,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    searchParams?: Record<string, string | string[]>;
  } = {},
): Promise<Record<string, unknown>> {
  const base = trimTrailingSlash(config.baseUrl);
  const url = new URL(path.startsWith("/") ? path : `/${path}`, base);
  if (options.searchParams) {
    for (const [k, v] of Object.entries(options.searchParams)) {
      if (v === undefined || v === "") continue;
      const arr = Array.isArray(v) ? v : [v];
      for (const val of arr) {
        if (val !== undefined && val !== "") {
          url.searchParams.append(k, val);
        }
      }
    }
  }
  const init: RequestInit = {
    method: options.method ?? "GET",
    headers: buildHeaders(config),
  };
  if (options.body !== undefined && options.method !== "GET") {
    init.body = JSON.stringify(options.body);
  }
  const { response, release } = await fetchWithSsrFGuard({
    url: url.toString(),
    init,
    policy: { allowPrivateNetwork: true },
    timeoutMs: 30_000,
    auditContext: "pixel-space",
  });
  const body = await response.text();
  await release();
  let data: Record<string, unknown> = {};
  try {
    if (body.trim()) {
      data = JSON.parse(body) as Record<string, unknown>;
    }
  } catch {
    // API may return plain text errors
  }
  if (!response.ok) {
    const msg =
      (data.error as string) ?? (data.message as string) ?? (body || `HTTP ${response.status}`);
    throw new Error(`pixel-space API error (${response.status}): ${msg}`);
  }
  return data;
}
