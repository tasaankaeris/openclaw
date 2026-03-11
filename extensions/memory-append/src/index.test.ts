import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
import type { OpenClawConfig, OpenClawPluginApi, PluginLogger } from "openclaw/plugin-sdk";
import plugin, { createMemoryAppendTool, shouldBlockManualMemoryEdit } from "../index.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk")>("openclaw/plugin-sdk");
  return {
    ...actual,
    jsonResult: (value: unknown) => value,
    readStringParam: (args: Record<string, unknown>, key: string, opts?: { required?: boolean }) => {
      const raw = args[key];
      if (raw == null) {
        if (opts?.required) return "";
        return "";
      }
      return typeof raw === "string" ? raw : String(raw);
    },
  };
});

vi.mock("./helpers.js", async () => {
  const actual = await vi.importActual<typeof import("./helpers.js")>("./helpers.js");
  return {
    ...actual,
    normalizeTags: (raw: unknown) => (Array.isArray(raw) ? (raw as string[]) : []),
    parseSessionContext: (sessionKey: string) => {
      if (!sessionKey) return null;
      const parts = sessionKey.split(":");
      if (parts[2] === "main") return { type: "main", id: parts[1] };
      if (parts[2] === "cron") return { type: "cron", id: parts[3] };
      if (parts[2] === "discord" && parts[3] === "channel") return { type: "channel", id: parts[4] };
      if (parts[2] === "discord" && parts[3] === "direct") return { type: "dm", id: parts[4] };
      return null;
    },
    resolveDiscordBotToken: vi.fn(() => "bot-token"),
    resolveDiscordChannelContextType: vi.fn(async () => "channel" as const),
  };
});

const spawnMock = vi.mocked(await import("node:child_process")).spawn as unknown as Mock;

function createTestLogger(): PluginLogger {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
}

describe("memory-append plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers the memory_append tool via plugin.default", () => {
    const tools: any[] = [];

    const api: OpenClawPluginApi = {
      pluginConfig: {},
      logger: createTestLogger(),
      registerTool(factory: (ctx: unknown) => unknown) {
        const tool = factory({
          workspaceDir: "/workspace",
        } as any);
        tools.push(tool);
      },
    } as any;

    (plugin as any).register(api);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("memory_append");
  });

  it("builds the correct command-line for a simple Discord channel session", async () => {
    const logger = createTestLogger();
    const tool = createMemoryAppendTool(
      {
        workspaceDir: "/workspace",
        sessionKey: "agent:nexus:discord:channel:123",
        agentAccountId: "nexus",
        config: {} as OpenClawConfig,
      } as any,
      {
        registryUrl: "https://registry.test",
        registryToken: "REGISTRY_SECRET_KEY",
        registryEnvFile: ".env.registry",
      },
      logger,
    );

    const stdoutOn = vi.fn();
    const stderrOn = vi.fn();
    const procOn = vi.fn((event: string, handler: (...args: any[]) => void) => {
      if (event === "close") {
        handler(0, null);
      }
    });

    spawnMock.mockReturnValue({
      stdout: { on: stdoutOn } as any,
      stderr: { on: stderrOn } as any,
      on: procOn as any,
      kill: vi.fn(),
    } as any);

    const result = await tool!.execute("call-1", { text: "hello", priority: "daily", tags: ["foo"] });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [binary, args] = spawnMock.mock.calls[0]!;
    expect(binary).toBe("memory-append");
    expect(args).toContain("--memory");
    expect(args).toContain("hello");
    expect(args).toContain("--priority");
    expect(args).toContain("daily");
    expect(args).toContain("--path");
    expect(args).toContain("/workspace/memory");
    expect(args).toContain("--channel");
    expect(args).toContain("123");
    expect(args).toContain("--registry-url");
    expect(args).toContain("https://registry.test");
    expect(args).toContain("--registry-token");
    expect(args).toContain("REGISTRY_SECRET_KEY");
    expect(args).toContain("--registry-env");
    expect(args).toContain(".env.registry");
    expect(args).toContain("--tags");
    expect(args).toContain("foo");

    expect((result as any).ok).toBe(true);
  });

  it("builds the correct command-line when an explicit threadId is provided", async () => {
    const logger = createTestLogger();
    const tool = createMemoryAppendTool(
      {
        workspaceDir: "/workspace",
        sessionKey: "agent:nexus:discord:channel:123",
        agentAccountId: "nexus",
        config: {} as OpenClawConfig,
      } as any,
      {},
      logger,
    );

    const stdoutOn = vi.fn();
    const stderrOn = vi.fn();
    const procOn = vi.fn((event: string, handler: (...args: any[]) => void) => {
      if (event === "close") {
        handler(0, null);
      }
    });

    spawnMock.mockReturnValue({
      stdout: { on: stdoutOn } as any,
      stderr: { on: stderrOn } as any,
      on: procOn as any,
      kill: vi.fn(),
    } as any);

    const result = await tool!.execute("call-1", {
      text: "hello thread",
      priority: "daily",
      threadId: "999",
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [binary, args] = spawnMock.mock.calls[0]!;
    expect(binary).toBe("memory-append");
    expect(args).toContain("--thread");
    expect(args).toContain("999");
    expect((result as any).ok).toBe(true);
  });

  it("fails with a clear error when the binary is missing", async () => {
    const logger = createTestLogger();
    const tool = createMemoryAppendTool(
      { workspaceDir: "/workspace" } as any,
      { binaryPath: "/does/not/exist/memory-append" },
      logger,
    );

    const error: any = new Error("ENOENT");
    error.code = "ENOENT";

    spawnMock.mockImplementation(() => {
      throw error;
    });

    const result = await tool!.execute("call-1", { text: "hello" });
    expect((result as any).ok).toBe(false);
    expect((result as any).error).toMatch("Memory append binary not found");
  });

  it("shouldBlockManualMemoryEdit blocks write/edit/apply_patch to daily memory files", () => {
    const paramsList: Record<string, unknown>[] = [
      { path: "memory/2026-03-11.md" },
      { path: "subdir/memory/2026-03-11.md" },
      { path: "C:\\workspace\\memory\\2026-03-11.md" },
      { files: ["other.txt", "memory/2026-03-11.md"] },
    ];

    for (const params of paramsList) {
      expect(shouldBlockManualMemoryEdit("write", params)).toBe(true);
      expect(shouldBlockManualMemoryEdit("edit", params)).toBe(true);
      expect(shouldBlockManualMemoryEdit("apply_patch", params)).toBe(true);
    }
  });

  it("shouldBlockManualMemoryEdit ignores non-memory paths and other tools", () => {
    const params = { path: "notes/2026-03-11.md" };
    expect(shouldBlockManualMemoryEdit("write", params)).toBe(false);
    expect(shouldBlockManualMemoryEdit("edit", params)).toBe(false);
    expect(shouldBlockManualMemoryEdit("apply_patch", params)).toBe(false);
    expect(shouldBlockManualMemoryEdit("read", { path: "memory/2026-03-11.md" })).toBe(false);
  });
});

