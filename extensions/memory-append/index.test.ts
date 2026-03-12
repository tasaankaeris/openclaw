import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import {
  DEFAULT_RECENT_MAX_LINE_CHARS,
  parseMemoryLine,
  selectRecentMatchingLines,
  type MemoryScope,
} from "./src/recent-memories.js";

describe("memory-append plugin registration", () => {
  it("registers memory_append tool, before_tool_call guard, and before_prompt_build hook", () => {
    const registerTool = vi.fn();
    const on = vi.fn();

    plugin.register?.({
      id: "memory-append",
      name: "memory-append",
      description: "memory-append",
      source: "test",
      config: {},
      pluginConfig: {},
      runtime: {} as never,
      logger: {
        info() {},
        warn() {},
        error() {},
      },
      registerTool,
      registerHook() {},
      registerHttpRoute() {},
      registerChannel() {},
      registerGatewayMethod() {},
      registerCli() {},
      registerService() {},
      registerProvider() {},
      registerCommand() {},
      resolvePath(input: string) {
        return input;
      },
      on,
    });

    expect(registerTool).toHaveBeenCalledTimes(1);
    const hookNames = on.mock.calls.map((call) => call[0] as string);
    expect(hookNames).toContain("before_tool_call");
    expect(hookNames).toContain("before_prompt_build");
  });
});

describe("memory-append recent memory helpers", () => {
  it("parses memory line with context and tags", () => {
    const line =
      "🔴 2026-02-26T08:58 [thread:1476493995772350516] [tags:backlog,review,design] Final approval granted.";
    const parsed = parseMemoryLine(line);
    expect(parsed.scopeType).toBe("thread");
    expect(parsed.scopeId).toBe("1476493995772350516");
  });

  it("selects recent matching lines for thread scope", () => {
    const lines = [
      "🔴 2026-02-26T08:58 [thread:1476493995772350516] [tags:backlog,review,design] Final approval granted.",
      "🟢 2026-02-26T10:12 [thread:1476493995772350516] [tags:backlog,review,status] Providing status update.",
    ];
    const scope: MemoryScope = { type: "thread", id: "1476493995772350516" };
    const selected = selectRecentMatchingLines(lines, scope, {
      maxLines: 10,
      maxChars: 2000,
      maxLineChars: DEFAULT_RECENT_MAX_LINE_CHARS,
    });
    expect(selected).toHaveLength(2);
    expect(selected[0]).toContain("[thread:1476493995772350516]");
  });

  it("selects channel-only or dm-only lines independently", () => {
    const lines = [
      "🔴 2026-03-11T07:55 [channel:1469620697935511564] [tags:channel,override] Testing memory_append with critical priority and channelId override (general channel).",
      "🔒 2026-03-11T07:55 [dm:1469619426792837130] [tags:dm,override] Testing memory_append with permanent priority and dmUserId override (Kaeris).",
    ];

    const channelScope: MemoryScope = { type: "channel", id: "1469620697935511564" };
    const dmScope: MemoryScope = { type: "dm", id: "1469619426792837130" };

    const selChannel = selectRecentMatchingLines(lines, channelScope, {
      maxLines: 10,
      maxChars: 2000,
      maxLineChars: DEFAULT_RECENT_MAX_LINE_CHARS,
    });
    const selDm = selectRecentMatchingLines(lines, dmScope, {
      maxLines: 10,
      maxChars: 2000,
      maxLineChars: DEFAULT_RECENT_MAX_LINE_CHARS,
    });

    expect(selChannel).toHaveLength(1);
    expect(selChannel[0]).toContain("[channel:1469620697935511564]");
    expect(selDm).toHaveLength(1);
    expect(selDm[0]).toContain("[dm:1469619426792837130]");
  });

});

