import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import {
  assertThreadBelongsToAllowedParent,
  canonicalUrlToGuid,
  discordFetch,
  encodeThreadReadCursor,
  normalizeReactionEmoji,
  readThreadMessages,
  resolveDiscordBotToken,
  resolveSandboxContainerWorkdirFromConfig,
  URL_NAMESPACE_UUID,
  validateAttachmentFilePath,
} from "./discord-thread-helpers";

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

describe("discordFetch", () => {
  it("retries on 503 with Retry-After and succeeds", async () => {
    let calls = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          ok: false,
          status: 503,
          headers: { get: () => "0" },
          text: async () => "service unavailable",
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ ok: true }),
      });
    });
    // @ts-expect-error override global fetch for test
    global.fetch = fetchMock;

    const res = await discordFetch("bot-token", "https://discord.com/api/v10/channels/x", {
      method: "GET",
    });
    expect(res.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("does not retry non-idempotent POST on 503", async () => {
    let calls = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      calls += 1;
      return Promise.resolve({
        ok: false,
        status: 503,
        headers: { get: () => "0" },
        text: async () => "service unavailable",
      });
    });
    // @ts-expect-error override global fetch for test
    global.fetch = fetchMock;

    const res = await discordFetch("bot-token", "https://discord.com/api/v10/channels/x/messages", {
      method: "POST",
      body: JSON.stringify({ content: "hello" }),
    });
    expect(res.status).toBe(503);
    expect(calls).toBe(1);
  });
});

describe("assertThreadBelongsToAllowedParent", () => {
  it("passes when guild and parent are allowed", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "thread-1",
        type: 11,
        guild_id: "guild-1",
        parent_id: "parent-1",
      }),
    });
    // @ts-expect-error override global fetch for test
    global.fetch = fetchMock;

    await expect(
      assertThreadBelongsToAllowedParent({
        token: "t",
        threadId: "thread-1",
        allowedGuildId: "guild-1",
        allowedParentChannelIds: ["parent-1"],
      }),
    ).resolves.toBeUndefined();
  });

  it("throws when guild does not match", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "thread-1",
        type: 11,
        guild_id: "guild-2",
        parent_id: "parent-1",
      }),
    });
    // @ts-expect-error override global fetch for test
    global.fetch = fetchMock;

    await expect(
      assertThreadBelongsToAllowedParent({
        token: "t",
        threadId: "thread-1",
        allowedGuildId: "guild-1",
        allowedParentChannelIds: ["parent-1"],
      }),
    ).rejects.toThrowError(/is in guild guild-2, not allowed guild guild-1/);
  });

  it("throws when parent channel is not allowed", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "thread-1",
        type: 11,
        guild_id: "guild-1",
        parent_id: "other-parent",
      }),
    });
    // @ts-expect-error override global fetch for test
    global.fetch = fetchMock;

    await expect(
      assertThreadBelongsToAllowedParent({
        token: "t",
        threadId: "thread-1",
        allowedGuildId: "guild-1",
        allowedParentChannelIds: ["parent-1"],
      }),
    ).rejects.toThrowError(/which is not in the allowed parent channel list/);
  });

  it("throws when channel is not a thread (e.g. text channel type 0)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "chan-1",
        type: 0,
        guild_id: "guild-1",
        parent_id: null,
      }),
    });
    // @ts-expect-error override global fetch for test
    global.fetch = fetchMock;

    await expect(
      assertThreadBelongsToAllowedParent({
        token: "t",
        threadId: "chan-1",
      }),
    ).rejects.toThrowError(/is not a thread.*type 0/);
  });
});

describe("normalizeReactionEmoji", () => {
  it("encodes unicode emoji for URL", () => {
    expect(normalizeReactionEmoji("✅")).toBe("%E2%9C%85");
  });

  it("strips variation selectors from unicode emoji", () => {
    // ⭐️ = U+2B50 U+FE0F; Discord expects U+2B50 only
    expect(normalizeReactionEmoji("⭐️")).toBe("%E2%AD%90");
  });

  it("converts custom emoji format to name:id and encodes", () => {
    expect(normalizeReactionEmoji("<:party_blob:123>")).toBe("party_blob%3A123");
    expect(normalizeReactionEmoji("<a:custom_animated:456>")).toBe("custom_animated%3A456");
  });

  it("throws when emoji is empty", () => {
    expect(() => normalizeReactionEmoji("")).toThrow(/emoji is required/);
    expect(() => normalizeReactionEmoji("   ")).toThrow(/emoji is required/);
  });
});

describe("validateAttachmentFilePath", () => {
  it("rejects data URLs (path-only attachments)", () => {
    expect(() =>
      validateAttachmentFilePath("data:image/png;base64,iVBORw0KGgo="),
    ).toThrow(/filesystem path only.*Base64\/data URLs are not supported/i);
    expect(() => validateAttachmentFilePath("DATA:text/plain;base64,SGVsbG8=")).toThrow(
      /filesystem path only.*Base64\/data URLs are not supported/i,
    );
  });

  it("rejects long base64-looking strings without path separators", () => {
    const longBase64 = "a".repeat(300);
    expect(() => validateAttachmentFilePath(longBase64)).toThrow(
      /Base64 or inline data is not supported/i,
    );
  });

  it("allows path under /workspace", () => {
    const p = path.sep === "/" ? "/workspace/foo.txt" : path.join(path.resolve("/workspace"), "foo.txt");
    const resolved = path.resolve(p);
    if (!resolved.includes("workspace")) {
      return; // skip on platforms where /workspace resolves elsewhere
    }
    expect(validateAttachmentFilePath(p)).toBe(resolved);
  });

  it("rejects path outside allowed roots", () => {
    expect(() => validateAttachmentFilePath("/etc/passwd")).toThrow(/not in an allowed location/);
  });

  it("rejects path that escapes root via ..", () => {
    const bad = path.join(path.resolve("/workspace"), "..", "etc", "passwd");
    expect(() => validateAttachmentFilePath(bad)).toThrow(/not in an allowed location/);
  });

  it("resolves relative path under workspaceRoot when provided", () => {
    const workspaceRoot = path.join(path.sep, "root", "agent-workspace");
    const resolved = validateAttachmentFilePath("tmp/ex-sessions/sessions.json", {
      workspaceRoot,
    });
    expect(resolved).toBe(path.resolve(workspaceRoot, "tmp", "ex-sessions", "sessions.json"));
  });

  it("rejects path that escapes workspaceRoot when workspaceRoot is set", () => {
    const workspaceRoot = path.join(path.sep, "root", "agent-workspace");
    expect(() =>
      validateAttachmentFilePath("../../../etc/passwd", { workspaceRoot }),
    ).toThrow(/must stay inside the workspace/);
  });

  it("resolves /workspace/... to workspaceRoot when sandboxed and workspaceRoot set", () => {
    const workspaceRoot = path.join(path.sep, "root", ".openclaw", "workspace-data");
    const resolved = validateAttachmentFilePath("/workspace/tmp/ex-sessions/sessions.json", {
      workspaceRoot,
      sandboxed: true,
    });
    expect(resolved).toBe(
      path.resolve(workspaceRoot, "tmp", "ex-sessions", "sessions.json"),
    );
  });

  it("does not map /workspace/... when not sandboxed; path must be under workspaceRoot", () => {
    const workspaceRoot = path.join(path.sep, "root", ".openclaw", "workspace-data");
    expect(() =>
      validateAttachmentFilePath("/workspace/tmp/file.json", {
        workspaceRoot,
        sandboxed: false,
      }),
    ).toThrow(/must stay inside the workspace/);
  });

  describe("agent data (host workspace /root/.openclaw/workspace-data, sandbox at /workspace)", () => {
    const workspaceDataRoot = path.join(path.sep, "root", ".openclaw", "workspace-data");

    it("sandboxed: accepts relative path", () => {
      const resolved = validateAttachmentFilePath("tmp/file.json", {
        workspaceRoot: workspaceDataRoot,
        sandboxed: true,
      });
      expect(resolved).toBe(path.resolve(workspaceDataRoot, "tmp", "file.json"));
    });

    it("sandboxed: accepts /workspace/... path", () => {
      const resolved = validateAttachmentFilePath("/workspace/tmp/file.json", {
        workspaceRoot: workspaceDataRoot,
        sandboxed: true,
      });
      expect(resolved).toBe(path.resolve(workspaceDataRoot, "tmp", "file.json"));
    });

    it("sandboxed: accepts host-absolute path under root", () => {
      const abs = path.join(workspaceDataRoot, "tmp", "file.json");
      const resolved = validateAttachmentFilePath(abs, {
        workspaceRoot: workspaceDataRoot,
        sandboxed: true,
      });
      expect(resolved).toBe(abs);
    });

    it("not sandboxed: accepts relative path", () => {
      const resolved = validateAttachmentFilePath("tmp/file.json", {
        workspaceRoot: workspaceDataRoot,
        sandboxed: false,
      });
      expect(resolved).toBe(path.resolve(workspaceDataRoot, "tmp", "file.json"));
    });

    it("not sandboxed: rejects /workspace/... path", () => {
      expect(() =>
        validateAttachmentFilePath("/workspace/tmp/file.json", {
          workspaceRoot: workspaceDataRoot,
          sandboxed: false,
        }),
      ).toThrow(/must stay inside the workspace/);
    });

    it("not sandboxed: accepts host-absolute path under root", () => {
      const abs = path.join(workspaceDataRoot, "tmp", "file.json");
      const resolved = validateAttachmentFilePath(abs, {
        workspaceRoot: workspaceDataRoot,
        sandboxed: false,
      });
      expect(resolved).toBe(abs);
    });
  });

  describe("agent kaylee (host workspace /root/.openclaw/agents/kaylee/workspace, sandbox at /workspace)", () => {
    const kayleeWorkspaceRoot = path.join(path.sep, "root", ".openclaw", "agents", "kaylee", "workspace");

    it("sandboxed: accepts relative path", () => {
      const resolved = validateAttachmentFilePath("tmp/file.json", {
        workspaceRoot: kayleeWorkspaceRoot,
        sandboxed: true,
      });
      expect(resolved).toBe(path.resolve(kayleeWorkspaceRoot, "tmp", "file.json"));
    });

    it("sandboxed: accepts /workspace/... path", () => {
      const resolved = validateAttachmentFilePath("/workspace/tmp/file.json", {
        workspaceRoot: kayleeWorkspaceRoot,
        sandboxed: true,
      });
      expect(resolved).toBe(path.resolve(kayleeWorkspaceRoot, "tmp", "file.json"));
    });

    it("sandboxed: accepts host-absolute path under root", () => {
      const abs = path.join(kayleeWorkspaceRoot, "tmp", "file.json");
      const resolved = validateAttachmentFilePath(abs, {
        workspaceRoot: kayleeWorkspaceRoot,
        sandboxed: true,
      });
      expect(resolved).toBe(abs);
    });

    it("not sandboxed: accepts relative path", () => {
      const resolved = validateAttachmentFilePath("tmp/file.json", {
        workspaceRoot: kayleeWorkspaceRoot,
        sandboxed: false,
      });
      expect(resolved).toBe(path.resolve(kayleeWorkspaceRoot, "tmp", "file.json"));
    });

    it("not sandboxed: rejects /workspace/... path", () => {
      expect(() =>
        validateAttachmentFilePath("/workspace/tmp/file.json", {
          workspaceRoot: kayleeWorkspaceRoot,
          sandboxed: false,
        }),
      ).toThrow(/must stay inside the workspace/);
    });

    it("not sandboxed: accepts host-absolute path under root", () => {
      const abs = path.join(kayleeWorkspaceRoot, "tmp", "file.json");
      const resolved = validateAttachmentFilePath(abs, {
        workspaceRoot: kayleeWorkspaceRoot,
        sandboxed: false,
      });
      expect(resolved).toBe(abs);
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

  describe("validateAttachmentFilePath with custom containerWorkdir (sandbox.docker.workdir)", () => {
    const workspaceRoot = path.join(path.sep, "root", "agent-workspace");

    it("maps container workdir path to workspaceRoot when containerWorkdir is set", () => {
      const resolved = validateAttachmentFilePath("/work/tmp/file.png", {
        workspaceRoot,
        sandboxed: true,
        containerWorkdir: "/work",
      });
      expect(resolved).toBe(path.resolve(workspaceRoot, "tmp", "file.png"));
    });

    it("does not map /workspace/... when containerWorkdir is /work", () => {
      expect(() =>
        validateAttachmentFilePath("/workspace/tmp/file.png", {
          workspaceRoot,
          sandboxed: true,
          containerWorkdir: "/work",
        }),
      ).toThrow(/must stay inside the workspace/);
    });

    it("maps exact container workdir to workspaceRoot", () => {
      const resolved = validateAttachmentFilePath("/work", {
        workspaceRoot,
        sandboxed: true,
        containerWorkdir: "/work",
      });
      expect(resolved).toBe(path.resolve(workspaceRoot));
    });
  });
});

describe("readThreadMessages", () => {
  function createMockResponse(params: {
    ok: boolean;
    status?: number;
    json?: unknown;
    text?: string;
    bytes?: Buffer;
    headers?: Record<string, string>;
  }) {
    return {
      ok: params.ok,
      status: params.status ?? (params.ok ? 200 : 500),
      headers: {
        get: (name: string) => {
          const key = Object.keys(params.headers ?? {}).find(
            (candidate) => candidate.toLowerCase() === name.toLowerCase(),
          );
          return key ? (params.headers?.[key] ?? null) : null;
        },
      },
      json: async () => params.json,
      text: async () => params.text ?? "",
      arrayBuffer: async () => {
        const bytes = params.bytes ?? Buffer.from("");
        const view = new Uint8Array(bytes);
        return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
      },
    };
  }

  function installThreadFetchMock(messages: Array<Record<string, unknown>>) {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/messages?")) {
        return Promise.resolve({
          ok: true,
          json: async () => messages,
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          id: "thread-1",
          type: 11,
          guild_id: "guild-1",
          parent_id: "parent-1",
        }),
      });
    });
    // @ts-expect-error override global fetch for test
    global.fetch = fetchMock;
    return fetchMock;
  }

  async function createTempWorkspaceDir(): Promise<string> {
    return await fs.mkdtemp(path.join(os.tmpdir(), "discord-thread-tools-"));
  }

  it("returns neutral navigation actions and earlier cursor for latest-window reads", async () => {
    installThreadFetchMock([
      {
        id: "900000000000000003",
        type: 0,
        author: { id: "u3", username: "gamma" },
        content: "third",
        timestamp: "2026-03-01T00:00:03.000Z",
      },
      {
        id: "900000000000000002",
        type: 0,
        author: { id: "u2", username: "beta" },
        content: "second",
        timestamp: "2026-03-01T00:00:02.000Z",
      },
      {
        id: "900000000000000001",
        type: 0,
        author: { id: "u1", username: "alpha" },
        content: "first",
        timestamp: "2026-03-01T00:00:01.000Z",
      },
    ]);
    const result = await readThreadMessages({
      token: "bot-token",
      allowedGuildId: "guild-1",
      allowedParentChannelIds: ["parent-1"],
      read: {
        accountId: "default",
        threadId: "thread-1",
        limit: 3,
        includeContent: true,
        contentMaxChars: 400,
        includeSystem: false,
        includeEmbeds: false,
        includeAttachments: false,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.messages.map((m) => m.id)).toEqual([
      "900000000000000001",
      "900000000000000002",
      "900000000000000003",
    ]);
    expect(result.window.boundaryExcludesAnchor).toBe(true);
    expect(result.earlierCursor).toBeTruthy();
    expect(result.nextActions?.readEarlierRequest).toMatchObject({
      accountId: "default",
      threadId: "thread-1",
      cursor: result.earlierCursor,
      direction: "earlier",
      limit: 3,
      includeContent: true,
      contentMaxChars: 400,
      includeEmbeds: false,
      includeAttachments: false,
      includeSystem: false,
    });
    expect(result.capabilities.attachmentDetail).toMatch(/aroundMessageId/);
    expect(result.dedupeKey).toBe("id");
  });

  it("throws when cursor threadId does not match request thread", async () => {
    installThreadFetchMock([]);
    const wrongCursor = encodeThreadReadCursor({
      v: 1,
      threadId: "thread-2",
      dir: "earlier",
      anchorFirstMessageId: "900000000000000001",
      anchorLastMessageId: "900000000000000003",
      limit: 3,
    });
    await expect(
      readThreadMessages({
        token: "bot-token",
        allowedGuildId: "guild-1",
        allowedParentChannelIds: ["parent-1"],
        read: {
          accountId: "default",
          threadId: "thread-1",
          limit: 3,
          cursor: wrongCursor,
          includeContent: true,
          contentMaxChars: 400,
          includeSystem: false,
          includeEmbeds: false,
          includeAttachments: false,
        },
      }),
    ).rejects.toThrow(/does not match requested threadId/);
  });

  it("uses raw window for attachment metadata when system messages are filtered out", async () => {
    installThreadFetchMock([
      {
        id: "900000000000000005",
        type: 0,
        author: { id: "u2", username: "beta" },
        content: "visible",
        timestamp: "2026-03-01T00:00:05.000Z",
      },
      {
        id: "900000000000000004",
        type: 7,
        author: { id: "u1", username: "alpha" },
        content: "system with attachment",
        timestamp: "2026-03-01T00:00:04.000Z",
        attachments: [{ id: "att-1", filename: "report.txt", url: "https://cdn.example/report.txt" }],
      },
    ]);
    const result = await readThreadMessages({
      token: "bot-token",
      allowedGuildId: "guild-1",
      allowedParentChannelIds: ["parent-1"],
      read: {
        accountId: "default",
        threadId: "thread-1",
        limit: 2,
        includeContent: true,
        contentMaxChars: 400,
        includeSystem: false,
        includeEmbeds: false,
        includeAttachments: false,
      },
    });

    expect(result.returnedCount).toBe(1);
    expect(result.rawCount).toBe(2);
    expect(result.filteredOutCount).toBe(1);
    expect(result.filtered).toEqual({ systemMessagesOmitted: 1 });
    expect(result.attachmentMessageIds).toEqual(["900000000000000004"]);
  });

  it("uses cursor limit when continuation omits limit", async () => {
    installThreadFetchMock([
      {
        id: "900000000000000010",
        type: 0,
        author: { id: "u10", username: "ten" },
        content: "ten",
        timestamp: "2026-03-01T00:00:10.000Z",
      },
      {
        id: "900000000000000009",
        type: 0,
        author: { id: "u9", username: "nine" },
        content: "nine",
        timestamp: "2026-03-01T00:00:09.000Z",
      },
    ]);
    const cursor = encodeThreadReadCursor({
      v: 1,
      threadId: "thread-1",
      dir: "earlier",
      anchorFirstMessageId: "900000000000000011",
      anchorLastMessageId: "900000000000000012",
      limit: 17,
    });
    const result = await readThreadMessages({
      token: "bot-token",
      allowedGuildId: "guild-1",
      allowedParentChannelIds: ["parent-1"],
      read: {
        accountId: "default",
        threadId: "thread-1",
        cursor,
        includeContent: true,
        contentMaxChars: 400,
        includeSystem: false,
        includeEmbeds: false,
        includeAttachments: false,
      },
    });
    expect(result.nextActions?.readEarlierRequest?.limit).toBe(17);
  });

  it("uses hydration default limit 5 when includeAttachments=true and limit omitted", async () => {
    installThreadFetchMock([
      {
        id: "900000000000000210",
        type: 0,
        author: { id: "u210", username: "two-ten" },
        content: "two-ten",
        timestamp: "2026-03-01T00:02:10.000Z",
        attachments: [{ id: "att-210", filename: "a.txt", url: "https://cdn.example/a.txt" }],
      },
    ]);
    const cursor = encodeThreadReadCursor({
      v: 1,
      threadId: "thread-1",
      dir: "earlier",
      anchorFirstMessageId: "900000000000000211",
      anchorLastMessageId: "900000000000000212",
      limit: 17,
    });
    const result = await readThreadMessages({
      token: "bot-token",
      allowedGuildId: "guild-1",
      allowedParentChannelIds: ["parent-1"],
      read: {
        accountId: "default",
        threadId: "thread-1",
        cursor,
        includeContent: true,
        contentMaxChars: 400,
        includeSystem: false,
        includeEmbeds: false,
        includeAttachments: true,
      },
    });
    expect(result.nextActions?.readEarlierRequest?.limit).toBe(5);
  });

  it("preserves opposite-direction cursor on zero-result continuation", async () => {
    installThreadFetchMock([]);
    const cursor = encodeThreadReadCursor({
      v: 1,
      threadId: "thread-1",
      dir: "later",
      anchorFirstMessageId: "900000000000000100",
      anchorLastMessageId: "900000000000000200",
      limit: 10,
    });
    const result = await readThreadMessages({
      token: "bot-token",
      allowedGuildId: "guild-1",
      allowedParentChannelIds: ["parent-1"],
      read: {
        accountId: "default",
        threadId: "thread-1",
        cursor,
        includeContent: true,
        contentMaxChars: 400,
        includeSystem: false,
        includeEmbeds: false,
        includeAttachments: false,
      },
    });
    expect(result.returnedCount).toBe(0);
    expect(result.laterCursor).toBeUndefined();
    expect(result.earlierCursor).toBeTruthy();
  });

  it("around mode omits bidirectional cursors on partial windows", async () => {
    installThreadFetchMock([
      {
        id: "900000000000000050",
        type: 0,
        author: { id: "u50", username: "fifty" },
        content: "fifty",
        timestamp: "2026-03-01T00:00:50.000Z",
      },
    ]);
    const result = await readThreadMessages({
      token: "bot-token",
      allowedGuildId: "guild-1",
      allowedParentChannelIds: ["parent-1"],
      read: {
        accountId: "default",
        threadId: "thread-1",
        aroundMessageId: "900000000000000050",
        limit: 30,
        includeContent: true,
        contentMaxChars: 400,
        includeSystem: false,
        includeEmbeds: false,
        includeAttachments: false,
      },
    });
    expect(result.earlierCursor).toBeUndefined();
    expect(result.laterCursor).toBeUndefined();
  });

  it("around mode can emit bidirectional cursors on full windows", async () => {
    installThreadFetchMock([
      {
        id: "900000000000000030",
        type: 0,
        author: { id: "u30", username: "thirty" },
        content: "thirty",
        timestamp: "2026-03-01T00:00:30.000Z",
      },
      {
        id: "900000000000000029",
        type: 0,
        author: { id: "u29", username: "twenty-nine" },
        content: "twenty-nine",
        timestamp: "2026-03-01T00:00:29.000Z",
      },
    ]);
    const result = await readThreadMessages({
      token: "bot-token",
      allowedGuildId: "guild-1",
      allowedParentChannelIds: ["parent-1"],
      read: {
        accountId: "default",
        threadId: "thread-1",
        aroundMessageId: "900000000000000030",
        limit: 2,
        includeContent: true,
        contentMaxChars: 400,
        includeSystem: false,
        includeEmbeds: false,
        includeAttachments: false,
      },
    });
    expect(result.earlierCursor).toBeTruthy();
    expect(result.laterCursor).toBeTruthy();
  });

  it("applies direction override when cursor is present", async () => {
    installThreadFetchMock([
      {
        id: "900000000000000040",
        type: 0,
        author: { id: "u40", username: "forty" },
        content: "forty",
        timestamp: "2026-03-01T00:00:40.000Z",
      },
    ]);
    const cursor = encodeThreadReadCursor({
      v: 1,
      threadId: "thread-1",
      dir: "earlier",
      anchorFirstMessageId: "900000000000000050",
      anchorLastMessageId: "900000000000000060",
      limit: 5,
    });
    const result = await readThreadMessages({
      token: "bot-token",
      allowedGuildId: "guild-1",
      allowedParentChannelIds: ["parent-1"],
      read: {
        accountId: "default",
        threadId: "thread-1",
        cursor,
        direction: "later",
        includeContent: true,
        contentMaxChars: 400,
        includeSystem: false,
        includeEmbeds: false,
        includeAttachments: false,
      },
    });
    expect(result.nextActions?.readLaterRequest?.direction).toBe("later");
  });

  it("returns filtered-only windows with continuation metadata", async () => {
    installThreadFetchMock([
      {
        id: "900000000000000070",
        type: 7,
        author: { id: "u70", username: "system" },
        content: "system message",
        timestamp: "2026-03-01T00:00:70.000Z",
      },
    ]);
    const result = await readThreadMessages({
      token: "bot-token",
      allowedGuildId: "guild-1",
      allowedParentChannelIds: ["parent-1"],
      read: {
        accountId: "default",
        threadId: "thread-1",
        limit: 1,
        includeContent: true,
        contentMaxChars: 400,
        includeSystem: false,
        includeEmbeds: false,
        includeAttachments: false,
      },
    });
    expect(result.messages).toEqual([]);
    expect(result.rawCount).toBe(1);
    expect(result.returnedCount).toBe(0);
    expect(result.filteredOutCount).toBe(1);
    expect(result.earlierCursor).toBeTruthy();
  });

  it("projects attachment and embed details when requested", async () => {
    installThreadFetchMock([
      {
        id: "900000000000000080",
        type: 0,
        author: { id: "u80", username: "eighty" },
        content: "rich message",
        timestamp: "2026-03-01T00:00:80.000Z",
        attachments: [
          {
            id: "att-80",
            filename: "log.txt",
            content_type: "text/plain",
            size: 12,
            url: "https://cdn.example/log.txt",
            proxy_url: "https://proxy.example/log.txt",
          },
        ],
        embeds: [
          {
            type: "link",
            title: "Example",
            description: "desc",
            url: "https://example.com",
          },
        ],
      },
    ]);
    const result = await readThreadMessages({
      token: "bot-token",
      allowedGuildId: "guild-1",
      allowedParentChannelIds: ["parent-1"],
      read: {
        accountId: "default",
        threadId: "thread-1",
        limit: 1,
        includeContent: true,
        contentMaxChars: 400,
        includeSystem: false,
        includeEmbeds: true,
        includeAttachments: true,
      },
    });
    expect(result.messages[0]?.attachments?.[0]).toMatchObject({
      id: "att-80",
      filename: "log.txt",
      contentType: "text/plain",
      size: 12,
      url: "https://cdn.example/log.txt",
      proxyUrl: "https://proxy.example/log.txt",
    });
    expect(result.messages[0]?.embeds?.[0]).toMatchObject({
      type: "link",
      title: "Example",
      description: "desc",
      url: "https://example.com",
    });
  });

  it("enforces limit <= 5 when includeAttachments is true", async () => {
    let messageFetchCount = 0;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/messages?")) {
        messageFetchCount += 1;
        return Promise.resolve(createMockResponse({ ok: true, json: [] }));
      }
      return Promise.resolve(
        createMockResponse({
          ok: true,
          json: { id: "thread-1", type: 11, guild_id: "guild-1", parent_id: "parent-1" },
        }),
      );
    });
    // @ts-expect-error override global fetch for test
    global.fetch = fetchMock;
    await expect(
      readThreadMessages({
        token: "bot-token",
        allowedGuildId: "guild-1",
        allowedParentChannelIds: ["parent-1"],
        read: {
          accountId: "default",
          threadId: "thread-1",
          limit: 6,
          includeContent: true,
          contentMaxChars: 400,
          includeSystem: false,
          includeEmbeds: false,
          includeAttachments: true,
          workspaceDir: "/tmp/workspace",
          sandboxed: true,
        },
      }),
    ).rejects.toThrow(/limit must be <= 5/);
    expect(messageFetchCount).toBe(0);
  });

  it("hydrates a specific aroundMessageId attachment with sandbox-usable localPath", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    try {
      const attachmentUrl = "https://cdn.example/specific.txt";
      const expectedGuid = canonicalUrlToGuid(attachmentUrl);
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/messages?")) {
          return Promise.resolve(
            createMockResponse({
              ok: true,
              json: [
                {
                  id: "900000000000000081",
                  type: 0,
                  author: { id: "u81", username: "eighty-one" },
                  content: "target",
                  timestamp: "2026-03-01T00:00:81.000Z",
                  attachments: [
                    {
                      id: "att-81",
                      filename: "specific.txt",
                      content_type: "text/plain",
                      url: attachmentUrl,
                    },
                  ],
                },
              ],
            }),
          );
        }
        if (url === attachmentUrl) {
          return Promise.resolve(createMockResponse({ ok: true, bytes: Buffer.from("payload-81") }));
        }
        return Promise.resolve(
          createMockResponse({
            ok: true,
            json: { id: "thread-1", type: 11, guild_id: "guild-1", parent_id: "parent-1" },
          }),
        );
      });
      // @ts-expect-error override global fetch for test
      global.fetch = fetchMock;

      const result = await readThreadMessages({
        token: "bot-token",
        allowedGuildId: "guild-1",
        allowedParentChannelIds: ["parent-1"],
        read: {
          accountId: "default",
          threadId: "thread-1",
          aroundMessageId: "900000000000000081",
          limit: 1,
          includeContent: true,
          contentMaxChars: 400,
          includeSystem: false,
          includeEmbeds: false,
          includeAttachments: true,
          workspaceDir,
          sandboxed: true,
        },
      });

      expect(result.messages[0]?.attachments?.[0]?.localPath).toBe(`media/inbound/${expectedGuid}/specific.txt`);
      expect(result.messages[0]?.attachments?.[0]?.hydrationFailure).toBeUndefined();
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("uses hash as filename when attachment has no or invalid filename", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    try {
      const attachmentUrl = "https://cdn.example/no-filename";
      const expectedHash = crypto.createHash("sha256").update(attachmentUrl, "utf8").digest("hex");
      const expectedGuid = canonicalUrlToGuid(attachmentUrl);
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/messages?")) {
          return Promise.resolve(
            createMockResponse({
              ok: true,
              json: [
                {
                  id: "900000000000000086",
                  type: 0,
                  author: { id: "u86", username: "u86" },
                  content: "no filename",
                  timestamp: "2026-03-01T00:00:86.000Z",
                  attachments: [{ id: "att-86", url: attachmentUrl }],
                },
              ],
            }),
          );
        }
        if (url === attachmentUrl) {
          return Promise.resolve(createMockResponse({ ok: true, bytes: Buffer.from("payload") }));
        }
        return Promise.resolve(
          createMockResponse({
            ok: true,
            json: { id: "thread-1", type: 11, guild_id: "guild-1", parent_id: "parent-1" },
          }),
        );
      });
      // @ts-expect-error override global fetch for test
      global.fetch = fetchMock;

      const result = await readThreadMessages({
        token: "bot-token",
        allowedGuildId: "guild-1",
        allowedParentChannelIds: ["parent-1"],
        read: {
          accountId: "default",
          threadId: "thread-1",
          limit: 1,
          includeContent: true,
          contentMaxChars: 400,
          includeSystem: false,
          includeEmbeds: false,
          includeAttachments: true,
          workspaceDir,
          sandboxed: true,
        },
      });

      expect(result.messages[0]?.attachments?.[0]?.localPath).toBe(`media/inbound/${expectedGuid}/${expectedHash}`);
      expect(result.messages[0]?.attachments?.[0]?.hydrationFailure).toBeUndefined();
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("sanitizes filename with path separators to avoid traversal", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    try {
      const attachmentUrl = "https://cdn.example/traversal";
      const expectedHash = crypto.createHash("sha256").update(attachmentUrl, "utf8").digest("hex");
      const expectedGuid = canonicalUrlToGuid(attachmentUrl);
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/messages?")) {
          return Promise.resolve(
            createMockResponse({
              ok: true,
              json: [
                {
                  id: "900000000000000087",
                  type: 0,
                  author: { id: "u87", username: "u87" },
                  content: "traversal",
                  timestamp: "2026-03-01T00:00:87.000Z",
                  attachments: [
                    { id: "att-87", filename: "..\\..\\evil.txt", url: attachmentUrl },
                  ],
                },
              ],
            }),
          );
        }
        if (url === attachmentUrl) {
          return Promise.resolve(createMockResponse({ ok: true, bytes: Buffer.from("x") }));
        }
        return Promise.resolve(
          createMockResponse({
            ok: true,
            json: { id: "thread-1", type: 11, guild_id: "guild-1", parent_id: "parent-1" },
          }),
        );
      });
      // @ts-expect-error override global fetch for test
      global.fetch = fetchMock;

      const result = await readThreadMessages({
        token: "bot-token",
        allowedGuildId: "guild-1",
        allowedParentChannelIds: ["parent-1"],
        read: {
          accountId: "default",
          threadId: "thread-1",
          limit: 1,
          includeContent: true,
          contentMaxChars: 400,
          includeSystem: false,
          includeEmbeds: false,
          includeAttachments: true,
          workspaceDir,
          sandboxed: true,
        },
      });

      expect(result.messages[0]?.attachments?.[0]?.localPath).toBe(`media/inbound/${expectedGuid}/evil.txt`);
      expect(result.messages[0]?.attachments?.[0]?.hydrationFailure).toBeUndefined();
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("sanitizes filename with forward-slash to avoid traversal", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    try {
      const attachmentUrl = "https://cdn.example/forward-slash";
      const expectedHash = crypto.createHash("sha256").update(attachmentUrl, "utf8").digest("hex");
      const expectedGuid = canonicalUrlToGuid(attachmentUrl);
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/messages?")) {
          return Promise.resolve(
            createMockResponse({
              ok: true,
              json: [
                {
                  id: "900000000000000088",
                  type: 0,
                  author: { id: "u88", username: "u88" },
                  content: "forward slash",
                  timestamp: "2026-03-01T00:00:88.000Z",
                  attachments: [
                    { id: "att-88", filename: "../other/file.txt", url: attachmentUrl },
                  ],
                },
              ],
            }),
          );
        }
        if (url === attachmentUrl) {
          return Promise.resolve(createMockResponse({ ok: true, bytes: Buffer.from("x") }));
        }
        return Promise.resolve(
          createMockResponse({
            ok: true,
            json: { id: "thread-1", type: 11, guild_id: "guild-1", parent_id: "parent-1" },
          }),
        );
      });
      // @ts-expect-error override global fetch for test
      global.fetch = fetchMock;

      const result = await readThreadMessages({
        token: "bot-token",
        allowedGuildId: "guild-1",
        allowedParentChannelIds: ["parent-1"],
        read: {
          accountId: "default",
          threadId: "thread-1",
          limit: 1,
          includeContent: true,
          contentMaxChars: 400,
          includeSystem: false,
          includeEmbeds: false,
          includeAttachments: true,
          workspaceDir,
          sandboxed: true,
        },
      });

      expect(result.messages[0]?.attachments?.[0]?.localPath).toBe(`media/inbound/${expectedGuid}/file.txt`);
      expect(result.messages[0]?.attachments?.[0]?.hydrationFailure).toBeUndefined();
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("uses hash when filename contains Windows reserved characters", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    try {
      const attachmentUrl = "https://cdn.example/reserved-chars";
      const expectedHash = crypto.createHash("sha256").update(attachmentUrl, "utf8").digest("hex");
      const expectedGuid = canonicalUrlToGuid(attachmentUrl);
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/messages?")) {
          return Promise.resolve(
            createMockResponse({
              ok: true,
              json: [
                {
                  id: "900000000000000089",
                  type: 0,
                  author: { id: "u89", username: "u89" },
                  content: "reserved",
                  timestamp: "2026-03-01T00:00:89.000Z",
                  attachments: [
                    { id: "att-89", filename: "file:name.txt", url: attachmentUrl },
                  ],
                },
              ],
            }),
          );
        }
        if (url === attachmentUrl) {
          return Promise.resolve(createMockResponse({ ok: true, bytes: Buffer.from("x") }));
        }
        return Promise.resolve(
          createMockResponse({
            ok: true,
            json: { id: "thread-1", type: 11, guild_id: "guild-1", parent_id: "parent-1" },
          }),
        );
      });
      // @ts-expect-error override global fetch for test
      global.fetch = fetchMock;

      const result = await readThreadMessages({
        token: "bot-token",
        allowedGuildId: "guild-1",
        allowedParentChannelIds: ["parent-1"],
        read: {
          accountId: "default",
          threadId: "thread-1",
          limit: 1,
          includeContent: true,
          contentMaxChars: 400,
          includeSystem: false,
          includeEmbeds: false,
          includeAttachments: true,
          workspaceDir,
          sandboxed: true,
        },
      });

      expect(result.messages[0]?.attachments?.[0]?.localPath).toBe(`media/inbound/${expectedGuid}/${expectedHash}`);
      expect(result.messages[0]?.attachments?.[0]?.hydrationFailure).toBeUndefined();
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("uses hash for dot-segment filename", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    try {
      const attachmentUrl = "https://cdn.example/dot-segment";
      const expectedHash = crypto.createHash("sha256").update(attachmentUrl, "utf8").digest("hex");
      const expectedGuid = canonicalUrlToGuid(attachmentUrl);
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/messages?")) {
          return Promise.resolve(
            createMockResponse({
              ok: true,
              json: [
                {
                  id: "900000000000000090",
                  type: 0,
                  author: { id: "u90", username: "u90" },
                  content: "dot segment",
                  timestamp: "2026-03-01T00:00:90.000Z",
                  attachments: [
                    { id: "att-90", filename: "..", url: attachmentUrl },
                  ],
                },
              ],
            }),
          );
        }
        if (url === attachmentUrl) {
          return Promise.resolve(createMockResponse({ ok: true, bytes: Buffer.from("x") }));
        }
        return Promise.resolve(
          createMockResponse({
            ok: true,
            json: { id: "thread-1", type: 11, guild_id: "guild-1", parent_id: "parent-1" },
          }),
        );
      });
      // @ts-expect-error override global fetch for test
      global.fetch = fetchMock;

      const result = await readThreadMessages({
        token: "bot-token",
        allowedGuildId: "guild-1",
        allowedParentChannelIds: ["parent-1"],
        read: {
          accountId: "default",
          threadId: "thread-1",
          limit: 1,
          includeContent: true,
          contentMaxChars: 400,
          includeSystem: false,
          includeEmbeds: false,
          includeAttachments: true,
          workspaceDir,
          sandboxed: true,
        },
      });

      expect(result.messages[0]?.attachments?.[0]?.localPath).toBe(`media/inbound/${expectedGuid}/${expectedHash}`);
      expect(result.messages[0]?.attachments?.[0]?.hydrationFailure).toBeUndefined();
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("reuses deterministic hydrated attachment unless forceReDownload is true", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    try {
      const attachmentUrl = "https://cdn.example/reuse.txt";
      let attachmentFetchCount = 0;
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/messages?")) {
          return Promise.resolve(
            createMockResponse({
              ok: true,
              json: [
                {
                  id: "900000000000000082",
                  type: 0,
                  author: { id: "u82", username: "eighty-two" },
                  content: "reuse",
                  timestamp: "2026-03-01T00:00:82.000Z",
                  attachments: [{ id: "att-82", filename: "reuse.txt", url: attachmentUrl }],
                },
              ],
            }),
          );
        }
        if (url === attachmentUrl) {
          attachmentFetchCount += 1;
          return Promise.resolve(createMockResponse({ ok: true, bytes: Buffer.from("payload-reuse") }));
        }
        return Promise.resolve(
          createMockResponse({
            ok: true,
            json: { id: "thread-1", type: 11, guild_id: "guild-1", parent_id: "parent-1" },
          }),
        );
      });
      // @ts-expect-error override global fetch for test
      global.fetch = fetchMock;

      await readThreadMessages({
        token: "bot-token",
        allowedGuildId: "guild-1",
        allowedParentChannelIds: ["parent-1"],
        read: {
          accountId: "default",
          threadId: "thread-1",
          limit: 1,
          includeContent: true,
          contentMaxChars: 400,
          includeSystem: false,
          includeEmbeds: false,
          includeAttachments: true,
          workspaceDir,
          sandboxed: true,
          forceReDownload: false,
        },
      });
      await readThreadMessages({
        token: "bot-token",
        allowedGuildId: "guild-1",
        allowedParentChannelIds: ["parent-1"],
        read: {
          accountId: "default",
          threadId: "thread-1",
          limit: 1,
          includeContent: true,
          contentMaxChars: 400,
          includeSystem: false,
          includeEmbeds: false,
          includeAttachments: true,
          workspaceDir,
          sandboxed: true,
          forceReDownload: false,
        },
      });
      expect(attachmentFetchCount).toBe(1);

      await readThreadMessages({
        token: "bot-token",
        allowedGuildId: "guild-1",
        allowedParentChannelIds: ["parent-1"],
        read: {
          accountId: "default",
          threadId: "thread-1",
          limit: 1,
          includeContent: true,
          contentMaxChars: 400,
          includeSystem: false,
          includeEmbeds: false,
          includeAttachments: true,
          workspaceDir,
          sandboxed: true,
          forceReDownload: true,
        },
      });
      expect(attachmentFetchCount).toBe(2);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("canonicalizes URL cache key by ignoring query params", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    try {
      const firstUrl = "https://cdn.example/cached.txt?ex=111&sig=aaa";
      const secondUrl = "https://cdn.example/cached.txt?ex=222&sig=bbb";
      let attachmentFetchCount = 0;
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/messages?")) {
          const attachmentUrl = attachmentFetchCount === 0 ? firstUrl : secondUrl;
          return Promise.resolve(
            createMockResponse({
              ok: true,
              json: [
                {
                  id: "900000000000000182",
                  type: 0,
                  author: { id: "u182", username: "u182" },
                  content: "cached",
                  timestamp: "2026-03-01T00:01:82.000Z",
                  attachments: [{ id: "att-182", filename: "cached.txt", url: attachmentUrl }],
                },
              ],
            }),
          );
        }
        if (url === firstUrl || url === secondUrl) {
          attachmentFetchCount += 1;
          return Promise.resolve(createMockResponse({ ok: true, bytes: Buffer.from("payload-cached") }));
        }
        return Promise.resolve(
          createMockResponse({
            ok: true,
            json: { id: "thread-1", type: 11, guild_id: "guild-1", parent_id: "parent-1" },
          }),
        );
      });
      // @ts-expect-error override global fetch for test
      global.fetch = fetchMock;

      await readThreadMessages({
        token: "bot-token",
        allowedGuildId: "guild-1",
        allowedParentChannelIds: ["parent-1"],
        read: {
          accountId: "default",
          threadId: "thread-1",
          limit: 1,
          includeContent: true,
          contentMaxChars: 400,
          includeSystem: false,
          includeEmbeds: false,
          includeAttachments: true,
          workspaceDir,
          sandboxed: true,
        },
      });
      await readThreadMessages({
        token: "bot-token",
        allowedGuildId: "guild-1",
        allowedParentChannelIds: ["parent-1"],
        read: {
          accountId: "default",
          threadId: "thread-1",
          limit: 1,
          includeContent: true,
          contentMaxChars: 400,
          includeSystem: false,
          includeEmbeds: false,
          includeAttachments: true,
          workspaceDir,
          sandboxed: true,
        },
      });
      expect(attachmentFetchCount).toBe(1);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("does not reuse zero-byte cached hydration file", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    try {
      const attachmentUrl = "https://cdn.example/zero-byte.txt?sig=xyz";
      const canonicalUrl = "https://cdn.example/zero-byte.txt";
      const hash = crypto.createHash("sha256").update(canonicalUrl, "utf8").digest("hex");
      const guid = canonicalUrlToGuid(canonicalUrl);
      const cachePath = path.join(workspaceDir, "media", "inbound", guid, "zero-byte.txt");
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(cachePath, Buffer.alloc(0));

      let attachmentFetchCount = 0;
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/messages?")) {
          return Promise.resolve(
            createMockResponse({
              ok: true,
              json: [
                {
                  id: "900000000000000184",
                  type: 0,
                  author: { id: "u184", username: "u184" },
                  content: "zero cache",
                  timestamp: "2026-03-01T00:01:84.000Z",
                  attachments: [{ id: "att-184", filename: "zero-byte.txt", url: attachmentUrl }],
                },
              ],
            }),
          );
        }
        if (url === attachmentUrl) {
          attachmentFetchCount += 1;
          return Promise.resolve(createMockResponse({ ok: true, bytes: Buffer.from("fresh-payload") }));
        }
        return Promise.resolve(
          createMockResponse({
            ok: true,
            json: { id: "thread-1", type: 11, guild_id: "guild-1", parent_id: "parent-1" },
          }),
        );
      });
      // @ts-expect-error override global fetch for test
      global.fetch = fetchMock;

      const result = await readThreadMessages({
        token: "bot-token",
        allowedGuildId: "guild-1",
        allowedParentChannelIds: ["parent-1"],
        read: {
          accountId: "default",
          threadId: "thread-1",
          limit: 1,
          includeContent: true,
          contentMaxChars: 400,
          includeSystem: false,
          includeEmbeds: false,
          includeAttachments: true,
          workspaceDir,
          sandboxed: true,
        },
      });
      expect(attachmentFetchCount).toBe(1);
      expect(result.messages[0]?.attachments?.[0]?.localPath).toBe(`media/inbound/${guid}/zero-byte.txt`);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("does not reuse cached file when attachment size mismatches", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    try {
      const attachmentUrl = "https://cdn.example/size-check.txt";
      const canonicalUrl = "https://cdn.example/size-check.txt";
      const hash = crypto.createHash("sha256").update(canonicalUrl, "utf8").digest("hex");
      const guid = canonicalUrlToGuid(canonicalUrl);
      const cachePath = path.join(workspaceDir, "media", "inbound", guid, "size-check.txt");
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(cachePath, Buffer.from("short"));

      let attachmentFetchCount = 0;
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/messages?")) {
          return Promise.resolve(
            createMockResponse({
              ok: true,
              json: [
                {
                  id: "900000000000000185",
                  type: 0,
                  author: { id: "u185", username: "u185" },
                  content: "size mismatch",
                  timestamp: "2026-03-01T00:01:85.000Z",
                  attachments: [
                    { id: "att-185", filename: "size-check.txt", url: attachmentUrl, size: 999 },
                  ],
                },
              ],
            }),
          );
        }
        if (url === attachmentUrl) {
          attachmentFetchCount += 1;
          return Promise.resolve(createMockResponse({ ok: true, bytes: Buffer.from("fresh-size-payload") }));
        }
        return Promise.resolve(
          createMockResponse({
            ok: true,
            json: { id: "thread-1", type: 11, guild_id: "guild-1", parent_id: "parent-1" },
          }),
        );
      });
      // @ts-expect-error override global fetch for test
      global.fetch = fetchMock;

      await readThreadMessages({
        token: "bot-token",
        allowedGuildId: "guild-1",
        allowedParentChannelIds: ["parent-1"],
        read: {
          accountId: "default",
          threadId: "thread-1",
          limit: 1,
          includeContent: true,
          contentMaxChars: 400,
          includeSystem: false,
          includeEmbeds: false,
          includeAttachments: true,
          workspaceDir,
          sandboxed: true,
        },
      });
      expect(attachmentFetchCount).toBe(1);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("returns host workspace absolute localPath when not sandboxed", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    try {
      const attachmentUrl = "https://cdn.example/non-sandbox.txt";
      const expectedHash = crypto.createHash("sha256").update("https://cdn.example/non-sandbox.txt", "utf8").digest("hex");
      const expectedGuid = canonicalUrlToGuid(attachmentUrl);
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/messages?")) {
          return Promise.resolve(
            createMockResponse({
              ok: true,
              json: [
                {
                  id: "900000000000000183",
                  type: 0,
                  author: { id: "u183", username: "u183" },
                  content: "non sandbox",
                  timestamp: "2026-03-01T00:01:83.000Z",
                  attachments: [{ id: "att-183", filename: "non-sandbox.txt", url: attachmentUrl }],
                },
              ],
            }),
          );
        }
        if (url === attachmentUrl) {
          return Promise.resolve(createMockResponse({ ok: true, bytes: Buffer.from("payload") }));
        }
        return Promise.resolve(
          createMockResponse({
            ok: true,
            json: { id: "thread-1", type: 11, guild_id: "guild-1", parent_id: "parent-1" },
          }),
        );
      });
      // @ts-expect-error override global fetch for test
      global.fetch = fetchMock;
      const result = await readThreadMessages({
        token: "bot-token",
        allowedGuildId: "guild-1",
        allowedParentChannelIds: ["parent-1"],
        read: {
          accountId: "default",
          threadId: "thread-1",
          limit: 1,
          includeContent: true,
          contentMaxChars: 400,
          includeSystem: false,
          includeEmbeds: false,
          includeAttachments: true,
          workspaceDir,
          sandboxed: false,
        },
      });
      expect(result.messages[0]?.attachments?.[0]?.localPath).toBe(
        path.join(workspaceDir, "media", "inbound", expectedGuid, "non-sandbox.txt"),
      );
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("retries on 503 Retry-After and transient network errors during hydration", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    try {
      const attachmentUrl = "https://cdn.example/retry.txt";
      let attachmentAttempts = 0;
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/messages?")) {
          return Promise.resolve(
            createMockResponse({
              ok: true,
              json: [
                {
                  id: "900000000000000083",
                  type: 0,
                  author: { id: "u83", username: "eighty-three" },
                  content: "retry",
                  timestamp: "2026-03-01T00:00:83.000Z",
                  attachments: [{ id: "att-83", filename: "retry.txt", url: attachmentUrl }],
                },
              ],
            }),
          );
        }
        if (url === attachmentUrl) {
          attachmentAttempts += 1;
          if (attachmentAttempts === 1) {
            return Promise.resolve(
              createMockResponse({
                ok: false,
                status: 503,
                headers: { "Retry-After": "0" },
                text: "unavailable",
              }),
            );
          }
          if (attachmentAttempts === 2) {
            const err = new Error("socket timeout") as Error & { code?: string };
            err.code = "ETIMEDOUT";
            return Promise.reject(err);
          }
          return Promise.resolve(createMockResponse({ ok: true, bytes: Buffer.from("payload-retry") }));
        }
        return Promise.resolve(
          createMockResponse({
            ok: true,
            json: { id: "thread-1", type: 11, guild_id: "guild-1", parent_id: "parent-1" },
          }),
        );
      });
      // @ts-expect-error override global fetch for test
      global.fetch = fetchMock;

      const result = await readThreadMessages({
        token: "bot-token",
        allowedGuildId: "guild-1",
        allowedParentChannelIds: ["parent-1"],
        read: {
          accountId: "default",
          threadId: "thread-1",
          limit: 1,
          includeContent: true,
          contentMaxChars: 400,
          includeSystem: false,
          includeEmbeds: false,
          includeAttachments: true,
          workspaceDir,
          sandboxed: true,
        },
      });
      expect(result.messages[0]?.attachments?.[0]?.localPath).toMatch(
        /^media\/inbound\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/retry\.txt$/,
      );
      expect(attachmentAttempts).toBe(3);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("marks attachment hydrationFailure and logs details on non-retryable failures", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    try {
      const attachmentUrl = "https://cdn.example/not-found.txt";
      const logger = { warn: vi.fn() };
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/messages?")) {
          return Promise.resolve(
            createMockResponse({
              ok: true,
              json: [
                {
                  id: "900000000000000084",
                  type: 0,
                  author: { id: "u84", username: "eighty-four" },
                  content: "missing",
                  timestamp: "2026-03-01T00:00:84.000Z",
                  attachments: [{ id: "att-84", filename: "missing.txt", url: attachmentUrl }],
                },
              ],
            }),
          );
        }
        if (url === attachmentUrl) {
          return Promise.resolve(createMockResponse({ ok: false, status: 404, text: "not found" }));
        }
        return Promise.resolve(
          createMockResponse({
            ok: true,
            json: { id: "thread-1", type: 11, guild_id: "guild-1", parent_id: "parent-1" },
          }),
        );
      });
      // @ts-expect-error override global fetch for test
      global.fetch = fetchMock;

      const result = await readThreadMessages({
        token: "bot-token",
        allowedGuildId: "guild-1",
        allowedParentChannelIds: ["parent-1"],
        logger,
        read: {
          accountId: "default",
          threadId: "thread-1",
          limit: 1,
          includeContent: true,
          contentMaxChars: 400,
          includeSystem: false,
          includeEmbeds: false,
          includeAttachments: true,
          workspaceDir,
          sandboxed: true,
        },
      });
      expect(result.messages[0]?.attachments?.[0]?.localPath).toBeUndefined();
      expect(result.messages[0]?.attachments?.[0]?.hydrationFailure).toBe(true);
      expect(logger.warn).toHaveBeenCalled();
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("marks hydrationFailure when workspaceDir is missing", async () => {
    const attachmentUrl = "https://cdn.example/no-workspace.txt";
    const logger = { warn: vi.fn() };
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/messages?")) {
        return Promise.resolve(
          createMockResponse({
            ok: true,
            json: [
              {
                id: "900000000000000085",
                type: 0,
                author: { id: "u85", username: "eighty-five" },
                content: "missing workspace",
                timestamp: "2026-03-01T00:00:85.000Z",
                attachments: [{ id: "att-85", filename: "no-workspace.txt", url: attachmentUrl }],
              },
            ],
          }),
        );
      }
      return Promise.resolve(
        createMockResponse({
          ok: true,
          json: { id: "thread-1", type: 11, guild_id: "guild-1", parent_id: "parent-1" },
        }),
      );
    });
    // @ts-expect-error override global fetch for test
    global.fetch = fetchMock;

    const result = await readThreadMessages({
      token: "bot-token",
      allowedGuildId: "guild-1",
      allowedParentChannelIds: ["parent-1"],
      logger,
      read: {
        accountId: "default",
        threadId: "thread-1",
        limit: 1,
        includeContent: true,
        contentMaxChars: 400,
        includeSystem: false,
        includeEmbeds: false,
        includeAttachments: true,
        sandboxed: true,
      },
    });
    expect(result.messages[0]?.attachments?.[0]?.localPath).toBeUndefined();
    expect(result.messages[0]?.attachments?.[0]?.hydrationFailure).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("truncates content when contentMaxChars is set", async () => {
    installThreadFetchMock([
      {
        id: "900000000000000090",
        type: 0,
        author: { id: "u90", username: "ninety" },
        content: "abcdefghijklmnopqrstuvwxyz",
        timestamp: "2026-03-01T00:00:90.000Z",
      },
    ]);
    const result = await readThreadMessages({
      token: "bot-token",
      allowedGuildId: "guild-1",
      allowedParentChannelIds: ["parent-1"],
      read: {
        accountId: "default",
        threadId: "thread-1",
        limit: 1,
        includeContent: true,
        contentMaxChars: 5,
        includeSystem: false,
        includeEmbeds: false,
        includeAttachments: false,
      },
    });
    expect(result.messages[0]?.content).toMatch(/^abcde \.\.\.\(truncated\)$/);
  });

  it("omits content when includeContent is false", async () => {
    installThreadFetchMock([
      {
        id: "900000000000000091",
        type: 0,
        author: { id: "u91", username: "ninety-one" },
        content: "should be hidden",
        timestamp: "2026-03-01T00:00:91.000Z",
      },
    ]);
    const result = await readThreadMessages({
      token: "bot-token",
      allowedGuildId: "guild-1",
      allowedParentChannelIds: ["parent-1"],
      read: {
        accountId: "default",
        threadId: "thread-1",
        limit: 1,
        includeContent: false,
        contentMaxChars: 0,
        includeSystem: false,
        includeEmbeds: false,
        includeAttachments: false,
      },
    });
    expect(result.messages[0]?.content).toBeUndefined();
  });

  it("throws on invalid cursor payload", async () => {
    installThreadFetchMock([]);
    await expect(
      readThreadMessages({
        token: "bot-token",
        allowedGuildId: "guild-1",
        allowedParentChannelIds: ["parent-1"],
        read: {
          accountId: "default",
          threadId: "thread-1",
          cursor: "not-a-valid-cursor",
          includeContent: true,
          contentMaxChars: 400,
          includeSystem: false,
          includeEmbeds: false,
          includeAttachments: false,
        },
      }),
    ).rejects.toThrow(/Invalid cursor/);
  });
});

