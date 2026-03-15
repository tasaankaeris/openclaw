import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import {
  assertThreadBelongsToAllowedParent,
  encodeThreadReadCursor,
  normalizeReactionEmoji,
  readThreadMessages,
  resolveDiscordBotToken,
  resolveSandboxContainerWorkdirFromConfig,
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

