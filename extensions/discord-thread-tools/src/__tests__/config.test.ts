import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import {
  canonicalUrlToGuid,
  resolveDiscordBotToken,
  resolveSandboxContainerWorkdirFromConfig,
  URL_NAMESPACE_UUID,
} from "../discord-thread-helpers";

vi.mock("openclaw/plugin-sdk", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk")>("openclaw/plugin-sdk");
  return {
    ...actual,
    resolveDiscordAccount: vi.fn((params: { cfg: OpenClawConfig; accountId: string }) => {
      const account = (params.cfg as any).channels?.discord?.accounts?.[params.accountId];
      if (!account) {
        throw new Error(`Missing discord account ${params.accountId}`);
      }
      return {
        accountId: params.accountId,
        enabled: account.enabled ?? true,
        token: account.token ?? "",
        config: account,
      };
    }),
  };
});

describe("canonicalUrlToGuid", () => {
  it("generates RFC 9562 UUIDv8 from canonical URL with URL namespace", () => {
    const url = "https://cdn.example.com/file.txt";
    const guid = canonicalUrlToGuid(url);

    // Should be valid UUID format
    expect(guid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    // Version nibble (char 14) should be 8
    expect(guid[14]).toBe("8");

    // Variant bits (char 19) should be 8, 9, a, or b (10xx in binary)
    expect(["8", "9", "a", "b"]).toContain(guid[19]);
  });

  it("produces deterministic UUIDs for same URL", () => {
    const url = "https://cdn.example.com/test.jpg";
    const guid1 = canonicalUrlToGuid(url);
    const guid2 = canonicalUrlToGuid(url);
    expect(guid1).toBe(guid2);
  });

  it("produces different UUIDs for different URLs", () => {
    const guid1 = canonicalUrlToGuid("https://cdn.example.com/a.txt");
    const guid2 = canonicalUrlToGuid("https://cdn.example.com/b.txt");
    expect(guid1).not.toBe(guid2);
  });

  it("uses RFC 4122 URL namespace UUID", () => {
    expect(URL_NAMESPACE_UUID).toBe("6ba7b811-9dad-11d1-80b4-00c04fd430c8");
  });
});

describe("resolveDiscordBotToken", () => {
  it("throws when config is missing", () => {
    expect(() =>
      resolveDiscordBotToken({
        // @ts-expect-error intentional undefined cfg
        cfg: undefined,
        accountId: "default",
      }),
    ).toThrowError(/Discord config is not available/);
  });

  it("returns token for enabled account with token", () => {
    const cfg = {
      channels: {
        discord: {
          accounts: {
            default: { enabled: true, token: "test-token" },
          },
        },
      },
    } satisfies Partial<OpenClawConfig> as OpenClawConfig;

    const token = resolveDiscordBotToken({ cfg, accountId: "default" });
    expect(token).toBe("test-token");
  });

  it("throws if account is disabled or missing token", () => {
    const cfg = {
      channels: {
        discord: {
          accounts: {
            disabled: { enabled: false, token: "x" },
            missingToken: { enabled: true },
          },
        },
      },
    } satisfies Partial<OpenClawConfig> as OpenClawConfig;

    expect(() => resolveDiscordBotToken({ cfg, accountId: "disabled" })).toThrowError(
      /is not enabled or missing token/,
    );
    expect(() => resolveDiscordBotToken({ cfg, accountId: "missingToken" })).toThrowError(
      /is not enabled or missing token/,
    );
  });
});

describe("resolveSandboxContainerWorkdirFromConfig", () => {
  it("returns /workspace when config is undefined", () => {
    expect(resolveSandboxContainerWorkdirFromConfig({})).toBe("/workspace");
  });

  it("returns /workspace when agents is missing", () => {
    expect(resolveSandboxContainerWorkdirFromConfig({ config: {} as OpenClawConfig })).toBe(
      "/workspace",
    );
  });

  it("returns default workdir from agents.defaults.sandbox.docker.workdir", () => {
    const cfg = {
      agents: {
        defaults: { sandbox: { docker: { workdir: "/app" } } },
      },
    } as unknown as OpenClawConfig;
    expect(resolveSandboxContainerWorkdirFromConfig({ config: cfg })).toBe("/app");
  });

  it("returns agent-specific workdir when agentId matches list entry", () => {
    const cfg = {
      agents: {
        defaults: { sandbox: { docker: { workdir: "/workspace" } } },
        list: [
          { id: "main", sandbox: { docker: { workdir: "/work" } } },
          { id: "other", sandbox: { docker: { workdir: "/other" } } },
        ],
      },
    } as unknown as OpenClawConfig;
    expect(resolveSandboxContainerWorkdirFromConfig({ config: cfg, agentId: "main" })).toBe("/work");
    expect(resolveSandboxContainerWorkdirFromConfig({ config: cfg, agentId: "other" })).toBe(
      "/other",
    );
  });

  it("falls back to default when agentId has no override", () => {
    const cfg = {
      agents: {
        defaults: { sandbox: { docker: { workdir: "/default" } } },
        list: [{ id: "main" }],
      },
    } as unknown as OpenClawConfig;
    expect(resolveSandboxContainerWorkdirFromConfig({ config: cfg, agentId: "main" })).toBe(
      "/default",
    );
  });

  it("matches agent by normalized id (case-insensitive, trim)", () => {
    const cfg = {
      agents: {
        defaults: { sandbox: { docker: { workdir: "/default" } } },
        list: [{ id: "Main", sandbox: { docker: { workdir: "/work" } } }],
      },
    } as unknown as OpenClawConfig;
    expect(resolveSandboxContainerWorkdirFromConfig({ config: cfg, agentId: "main" })).toBe(
      "/work",
    );
    expect(resolveSandboxContainerWorkdirFromConfig({ config: cfg, agentId: "  Main  " })).toBe(
      "/work",
    );
  });
});
