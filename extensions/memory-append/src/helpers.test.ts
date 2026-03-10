import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import {
  _clearDiscordChannelCacheForTests,
  fetchDiscordChannel,
  normalizeTags,
  parseSessionContext,
  resolveDiscordBotToken,
  resolveDiscordChannelContextType,
} from "./helpers";

vi.mock("openclaw/plugin-sdk", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk")>("openclaw/plugin-sdk");
  return {
    ...actual,
    resolveDiscordAccount: vi.fn((params: { cfg: OpenClawConfig; accountId: string }) => {
      const account = (params.cfg as any).channels?.discord?.accounts?.[params.accountId];
      if (!account) throw new Error(`Missing discord account ${params.accountId}`);
      return {
        accountId: params.accountId,
        enabled: account.enabled ?? true,
        token: account.token ?? "",
        config: account,
      };
    }),
  };
});

beforeEach(() => {
  _clearDiscordChannelCacheForTests();
});

// ─── parseSessionContext ──────────────────────────────────────────────────────

describe("parseSessionContext", () => {
  it("returns null for empty string", () => {
    expect(parseSessionContext("")).toBeNull();
  });

  it("returns null for non-discord session key", () => {
    expect(parseSessionContext("agent:nexus:telegram:user:123456")).toBeNull();
  });

  it("returns null for key with fewer than 5 parts", () => {
    expect(parseSessionContext("agent:nexus:discord:channel")).toBeNull();
  });

  it("parses a discord channel session key", () => {
    const result = parseSessionContext("agent:nexus:discord:channel:1472568986670731417");
    expect(result).toEqual({ type: "channel", id: "1472568986670731417" });
  });

  it("parses a discord thread session (uses same channel key format)", () => {
    // Threads appear as channel sessions from the sessionKey perspective.
    const result = parseSessionContext("agent:nexus:discord:channel:1474177564875554950");
    expect(result).toEqual({ type: "channel", id: "1474177564875554950" });
  });

  it("parses a discord DM session key", () => {
    const result = parseSessionContext("agent:nexus:discord:direct:987654321098765432");
    expect(result).toEqual({ type: "dm", id: "987654321098765432" });
  });

  it("returns null for unknown discord peer kind", () => {
    expect(parseSessionContext("agent:nexus:discord:group:123456789")).toBeNull();
  });

  it("agentId segment can be any string, not just 'nexus'", () => {
    const result = parseSessionContext("agent:kaylee:discord:channel:111222333444555666");
    expect(result).toEqual({ type: "channel", id: "111222333444555666" });
  });
});

// ─── normalizeTags ────────────────────────────────────────────────────────────

describe("normalizeTags", () => {
  it("returns empty array for non-array", () => {
    expect(normalizeTags(null)).toEqual([]);
    expect(normalizeTags(undefined)).toEqual([]);
    expect(normalizeTags("string")).toEqual([]);
    expect(normalizeTags(42)).toEqual([]);
  });

  it("returns empty array for empty array", () => {
    expect(normalizeTags([])).toEqual([]);
  });

  it("trims and returns valid string tags", () => {
    expect(normalizeTags(["security", "go"])).toEqual(["security", "go"]);
  });

  it("trims whitespace from each tag", () => {
    expect(normalizeTags(["  security  ", " go "])).toEqual(["security", "go"]);
  });

  it("replaces spaces and commas with hyphens", () => {
    expect(normalizeTags(["helm security audit"])).toEqual(["helm-security-audit"]);
    expect(normalizeTags(["go,source"])).toEqual(["go-source"]);
  });

  it("drops empty entries after trimming", () => {
    expect(normalizeTags(["security", "", "  ", "go"])).toEqual(["security", "go"]);
  });

  it("skips non-string entries", () => {
    expect(normalizeTags([42, null, "security", true])).toEqual(["security"]);
  });
});

// ─── resolveDiscordBotToken ───────────────────────────────────────────────────

describe("resolveDiscordBotToken", () => {
  it("returns null when cfg is undefined", () => {
    expect(resolveDiscordBotToken({ cfg: undefined, accountId: "nexus" })).toBeNull();
  });

  it("returns token for enabled account with token", () => {
    const cfg = {
      channels: {
        discord: { accounts: { nexus: { enabled: true, token: "bot-token-abc" } } },
      },
    } satisfies Partial<OpenClawConfig> as OpenClawConfig;

    expect(resolveDiscordBotToken({ cfg, accountId: "nexus" })).toBe("bot-token-abc");
  });

  it("returns null when account is disabled", () => {
    const cfg = {
      channels: {
        discord: { accounts: { nexus: { enabled: false, token: "bot-token-abc" } } },
      },
    } satisfies Partial<OpenClawConfig> as OpenClawConfig;

    expect(resolveDiscordBotToken({ cfg, accountId: "nexus" })).toBeNull();
  });

  it("returns null when account has no token", () => {
    const cfg = {
      channels: {
        discord: { accounts: { nexus: { enabled: true } } },
      },
    } satisfies Partial<OpenClawConfig> as OpenClawConfig;

    expect(resolveDiscordBotToken({ cfg, accountId: "nexus" })).toBeNull();
  });

  it("returns null when account is missing entirely", () => {
    const cfg = {
      channels: { discord: { accounts: {} } },
    } satisfies Partial<OpenClawConfig> as OpenClawConfig;

    expect(resolveDiscordBotToken({ cfg, accountId: "nexus" })).toBeNull();
  });
});

// ─── fetchDiscordChannel ──────────────────────────────────────────────────────

describe("fetchDiscordChannel", () => {
  it("returns channel when fetch succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "ch-1", type: 0, parent_id: "cat-1" }),
      }),
    );

    const result = await fetchDiscordChannel("token", "ch-1");
    expect(result).toEqual({ id: "ch-1", type: 0, parent_id: "cat-1" });
  });

  it("returns null when fetch returns non-200", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: false }));
    expect(await fetchDiscordChannel("token", "ch-1")).toBeNull();
  });

  it("returns null when response shape is invalid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ not_a_channel: true }),
      }),
    );
    expect(await fetchDiscordChannel("token", "ch-1")).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("network error")));
    expect(await fetchDiscordChannel("token", "ch-1")).toBeNull();
  });

  it("returns cached channel on second call without hitting Discord", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "cached-ch", type: 11, parent_id: "parent-1" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = await fetchDiscordChannel("token", "cached-ch");
    const second = await fetchDiscordChannel("token", "cached-ch");
    expect(first).toEqual({ id: "cached-ch", type: 11, parent_id: "parent-1" });
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ─── resolveDiscordChannelContextType ───────────────────────────────────────────

describe("resolveDiscordChannelContextType", () => {
  it("returns null when botToken is null", async () => {
    expect(await resolveDiscordChannelContextType(null, "ch-1")).toBeNull();
  });

  it("returns thread for Discord type 11 (public thread)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "thread-1", type: 11, parent_id: "parent-1" }),
      }),
    );
    expect(await resolveDiscordChannelContextType("token", "thread-1")).toBe("thread");
  });

  it("returns thread for Discord type 12 (private thread)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "thread-2", type: 12 }),
      }),
    );
    expect(await resolveDiscordChannelContextType("token", "thread-2")).toBe("thread");
  });

  it("returns channel for Discord type 0 (guild text)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "ch-1", type: 0 }),
      }),
    );
    expect(await resolveDiscordChannelContextType("token", "ch-1")).toBe("channel");
  });

  it("returns null when fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: false }));
    expect(await resolveDiscordChannelContextType("token", "ch-1")).toBeNull();
  });
});

import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import {
  _clearDiscordChannelCacheForTests,
  fetchDiscordChannel,
  normalizeTags,
  parseSessionContext,
  resolveDiscordBotToken,
  resolveDiscordChannelContextType,
  resolveProject,
} from "./helpers";

vi.mock("openclaw/plugin-sdk", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk")>("openclaw/plugin-sdk");
  return {
    ...actual,
    resolveDiscordAccount: vi.fn((params: { cfg: OpenClawConfig; accountId: string }) => {
      const account = (params.cfg as any).channels?.discord?.accounts?.[params.accountId];
      if (!account) throw new Error(`Missing discord account ${params.accountId}`);
      return {
        accountId: params.accountId,
        enabled: account.enabled ?? true,
        token: account.token ?? "",
        config: account,
      };
    }),
  };
});

beforeEach(() => {
  _clearDiscordChannelCacheForTests();
});

// ─── parseSessionContext ──────────────────────────────────────────────────────

describe("parseSessionContext", () => {
  it("returns null for empty string", () => {
    expect(parseSessionContext("")).toBeNull();
  });

  it("returns null for non-discord session key", () => {
    expect(parseSessionContext("agent:nexus:telegram:user:123456")).toBeNull();
  });

  it("returns null for key with fewer than 5 parts", () => {
    expect(parseSessionContext("agent:nexus:discord:channel")).toBeNull();
  });

  it("parses a discord channel session key", () => {
    const result = parseSessionContext("agent:nexus:discord:channel:1472568986670731417");
    expect(result).toEqual({ type: "channel", id: "1472568986670731417" });
  });

  it("parses a discord thread session (uses same channel key format)", () => {
    // Threads appear as channel sessions from the sessionKey perspective.
    const result = parseSessionContext("agent:nexus:discord:channel:1474177564875554950");
    expect(result).toEqual({ type: "channel", id: "1474177564875554950" });
  });

  it("parses a discord DM session key", () => {
    const result = parseSessionContext("agent:nexus:discord:direct:987654321098765432");
    expect(result).toEqual({ type: "dm", id: "987654321098765432" });
  });

  it("returns null for unknown discord peer kind", () => {
    expect(parseSessionContext("agent:nexus:discord:group:123456789")).toBeNull();
  });

  it("agentId segment can be any string, not just 'nexus'", () => {
    const result = parseSessionContext("agent:kaylee:discord:channel:111222333444555666");
    expect(result).toEqual({ type: "channel", id: "111222333444555666" });
  });
});

// ─── normalizeTags ────────────────────────────────────────────────────────────

describe("normalizeTags", () => {
  it("returns empty array for non-array", () => {
    expect(normalizeTags(null)).toEqual([]);
    expect(normalizeTags(undefined)).toEqual([]);
    expect(normalizeTags("string")).toEqual([]);
    expect(normalizeTags(42)).toEqual([]);
  });

  it("returns empty array for empty array", () => {
    expect(normalizeTags([])).toEqual([]);
  });

  it("trims and returns valid string tags", () => {
    expect(normalizeTags(["security", "go"])).toEqual(["security", "go"]);
  });

  it("trims whitespace from each tag", () => {
    expect(normalizeTags(["  security  ", " go "])).toEqual(["security", "go"]);
  });

  it("replaces spaces and commas with hyphens", () => {
    expect(normalizeTags(["helm security audit"])).toEqual(["helm-security-audit"]);
    expect(normalizeTags(["go,source"])).toEqual(["go-source"]);
  });

  it("drops empty entries after trimming", () => {
    expect(normalizeTags(["security", "", "  ", "go"])).toEqual(["security", "go"]);
  });

  it("skips non-string entries", () => {
    expect(normalizeTags([42, null, "security", true])).toEqual(["security"]);
  });
});

// ─── resolveDiscordBotToken ───────────────────────────────────────────────────

describe("resolveDiscordBotToken", () => {
  it("returns null when cfg is undefined", () => {
    expect(resolveDiscordBotToken({ cfg: undefined, accountId: "nexus" })).toBeNull();
  });

  it("returns token for enabled account with token", () => {
    const cfg = {
      channels: {
        discord: { accounts: { nexus: { enabled: true, token: "bot-token-abc" } } },
      },
    } satisfies Partial<OpenClawConfig> as OpenClawConfig;

    expect(resolveDiscordBotToken({ cfg, accountId: "nexus" })).toBe("bot-token-abc");
  });

  it("returns null when account is disabled", () => {
    const cfg = {
      channels: {
        discord: { accounts: { nexus: { enabled: false, token: "bot-token-abc" } } },
      },
    } satisfies Partial<OpenClawConfig> as OpenClawConfig;

    expect(resolveDiscordBotToken({ cfg, accountId: "nexus" })).toBeNull();
  });

  it("returns null when account has no token", () => {
    const cfg = {
      channels: {
        discord: { accounts: { nexus: { enabled: true } } },
      },
    } satisfies Partial<OpenClawConfig> as OpenClawConfig;

    expect(resolveDiscordBotToken({ cfg, accountId: "nexus" })).toBeNull();
  });

  it("returns null when account is missing entirely", () => {
    const cfg = {
      channels: { discord: { accounts: {} } },
    } satisfies Partial<OpenClawConfig> as OpenClawConfig;

    expect(resolveDiscordBotToken({ cfg, accountId: "nexus" })).toBeNull();
  });
});

// ─── fetchDiscordChannel ──────────────────────────────────────────────────────

describe("fetchDiscordChannel", () => {
  it("returns channel when fetch succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "ch-1", type: 0, parent_id: "cat-1" }),
      }),
    );

    const result = await fetchDiscordChannel("token", "ch-1");
    expect(result).toEqual({ id: "ch-1", type: 0, parent_id: "cat-1" });
  });

  it("returns null when fetch returns non-200", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: false }));
    expect(await fetchDiscordChannel("token", "ch-1")).toBeNull();
  });

  it("returns null when response shape is invalid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ not_a_channel: true }),
      }),
    );
    expect(await fetchDiscordChannel("token", "ch-1")).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("network error")));
    expect(await fetchDiscordChannel("token", "ch-1")).toBeNull();
  });

  it("returns cached channel on second call without hitting Discord", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "cached-ch", type: 11, parent_id: "parent-1" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = await fetchDiscordChannel("token", "cached-ch");
    const second = await fetchDiscordChannel("token", "cached-ch");
    expect(first).toEqual({ id: "cached-ch", type: 11, parent_id: "parent-1" });
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ─── resolveDiscordChannelContextType ───────────────────────────────────────────

describe("resolveDiscordChannelContextType", () => {
  it("returns null when botToken is null", async () => {
    expect(await resolveDiscordChannelContextType(null, "ch-1")).toBeNull();
  });

  it("returns thread for Discord type 11 (public thread)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "thread-1", type: 11, parent_id: "parent-1" }),
      }),
    );
    expect(await resolveDiscordChannelContextType("token", "thread-1")).toBe("thread");
  });

  it("returns thread for Discord type 12 (private thread)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "thread-2", type: 12 }),
      }),
    );
    expect(await resolveDiscordChannelContextType("token", "thread-2")).toBe("thread");
  });

  it("returns channel for Discord type 0 (guild text)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "ch-1", type: 0 }),
      }),
    );
    expect(await resolveDiscordChannelContextType("token", "ch-1")).toBe("channel");
  });

  it("returns null when fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: false }));
    expect(await resolveDiscordChannelContextType("token", "ch-1")).toBeNull();
  });
});

// ─── resolveProject ───────────────────────────────────────────────────────────

describe("resolveProject", () => {
  const BASE = "http://registry.example.com";
  const SECRET = "test-secret";

  it("resolves via thread lookup on first hit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ projectId: "openclaw-mobile" }),
      }),
    );

    const result = await resolveProject(BASE, SECRET, "thread-123", null);
    expect(result).toBe("openclaw-mobile");
  });

  it("resolves via parent channel when thread lookup misses", async () => {
    const fetchMock = vi
      .fn()
      // 1. Thread lookup → 404
      .mockResolvedValueOnce({ ok: false })
      // 2. Discord GET /channels/{id} → thread with parent
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "thread-1", type: 11, parent_id: "phase-channel-1" }),
      })
      // 3. Registry /lookup/channel/{parent_id} → match
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ projectId: "openclaw-mobile" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveProject(BASE, SECRET, "thread-1", "bot-token");
    expect(result).toBe("openclaw-mobile");
  });

  it("resolves via channel lookup when thread has no parent", async () => {
    const fetchMock = vi
      .fn()
      // 1. Thread lookup → 404
      .mockResolvedValueOnce({ ok: false })
      // 2. Discord GET /channels/{id} → channel with no parent_id
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "ch-1", type: 0 }),
      })
      // 3. Registry /lookup/channel/{id} → match
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ projectId: "openclaw-mobile" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveProject(BASE, SECRET, "ch-1", "bot-token");
    expect(result).toBe("openclaw-mobile");
  });

  it("returns null when all lookups fail", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const result = await resolveProject(BASE, SECRET, "unknown-id", "bot-token");
    expect(result).toBeNull();
  });

  it("returns null when fetch throws on all steps", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const result = await resolveProject(BASE, SECRET, "any-id", "bot-token");
    expect(result).toBeNull();
  });

  it("skips Discord API step when botToken is null", async () => {
    const fetchMock = vi
      .fn()
      // 1. Thread lookup → miss
      .mockResolvedValueOnce({ ok: false })
      // 2. Channel lookup (step 3 - no bot step) → match
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ projectId: "some-project" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveProject(BASE, SECRET, "ch-1", null);
    expect(result).toBe("some-project");
    // Only 2 fetches: thread + channel (no Discord API call)
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
