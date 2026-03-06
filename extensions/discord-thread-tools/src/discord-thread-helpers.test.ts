import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import {
  assertThreadBelongsToAllowedParent,
  normalizeReactionEmoji,
  resolveDiscordBotToken,
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
});

