import { describe, expect, it, vi } from "vitest";
import type { RunProcessFn } from "./tool.js";
import { createWorktreeSwapTool } from "./tool.js";
import plugin from "./index.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    throw new Error("REAL_PROCESS_GUARD: Tests must use mocked runProcess; real git must not run.");
  }),
}));

const WORKTREE = "/home/openclaw/.openclaw/worktrees/agent-1";
const BARE = "/home/openclaw/.openclaw/repos/openclaw.git";

function mockRunProcess(
  responses: Array<{ exitCode: number; stdout?: string; stderr?: string }>,
): { fn: RunProcessFn } {
  let idx = 0;
  const fn = vi.fn(async (argv: string[]) => {
    const r = responses[idx] ?? { exitCode: 1, stdout: "", stderr: "unexpected call" };
    idx += 1;
    return {
      exitCode: r.exitCode,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
    };
  });
  return { fn };
}

function createTool(opts: {
  agentId?: string;
  sessionKey?: string;
  pluginConfig?: Record<string, unknown>;
  runProcess?: RunProcessFn;
}) {
  const { runProcess, ...rest } = opts;
  return createWorktreeSwapTool({
    api: { pluginConfig: rest.pluginConfig ?? {} },
    ctx: {
      agentId: opts.agentId,
      sessionKey: opts.sessionKey,
    },
    runProcess,
  });
}

describe("git-worktree plugin registration", () => {
  it("registers worktree_swap_branch tool via factory", () => {
    const registerTool = vi.fn();
    plugin.register?.({
      id: "git-worktree",
      name: "Git Worktree",
      description: "Worktree",
      source: "test",
      config: {},
      pluginConfig: {},
      runtime: {} as never,
      logger: { info() {}, warn() {}, error() {} },
      registerTool,
      registerHook() {},
      registerHttpRoute() {},
      registerChannel() {},
      registerGatewayMethod() {},
      registerCli() {},
      registerService() {},
      registerProvider() {},
      registerCommand() {},
      resolvePath: (x) => x,
      on: () => {},
    });
    expect(registerTool).toHaveBeenCalledTimes(1);
    const arg = registerTool.mock.calls[0]?.[0];
    expect(typeof arg).toBe("function");
    const tool = (arg as (ctx: { agentId?: string }) => unknown)({ agentId: "agent-1" });
    expect(tool).toBeDefined();
    expect(typeof (tool as { name?: string }).name).toBe("string");
    expect((tool as { name: string }).name).toBe("worktree_swap_branch");
  });
});

describe("worktree_swap_branch hermetic", () => {
  it("fails CALLER_ID_MISSING when agentId and sessionKey are absent", async () => {
    const tool = createTool({ pluginConfig: {} });
    const result = await tool.execute?.("t1", { targetBranch: "feat/x" });
    const details = (result as { details?: { errorCode?: string } })?.details;
    expect(details?.errorCode).toBe("CALLER_ID_MISSING");
    expect((details as { noChangeApplied?: boolean })?.noChangeApplied).toBe(true);
  });

  it("resolves agentId from sessionKey agent:xxx when agentId missing", async () => {
    const mock = mockRunProcess([
      { exitCode: 0, stdout: BARE },
      { exitCode: 0 },
      { exitCode: 0, stdout: "main" },
      { exitCode: 0, stdout: "## main\n" },
      { exitCode: 0, stdout: "origin/main" },
      { exitCode: 0, stdout: "0\t0" },
      { exitCode: 1 },
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0, stdout: "feat/x" },
      { exitCode: 0, stdout: "abc123" },
    ]);
    const tool = createTool({
      sessionKey: "agent:agent-1:session",
      pluginConfig: {
        assignments: { "agent-1": { worktreePath: WORKTREE, bareRepoPath: BARE } },
        allowedBaseRefs: ["origin/main"],
      },
      runProcess: mock.fn,
    });
    const result = await tool.execute?.("t1", { targetBranch: "feat/x" });
    const details = (result as { details?: Record<string, unknown> })?.details;
    expect(details?.ok).toBe(true);
    expect(details?.newBranch).toBe("feat/x");
  });

  it("fails AGENT_WORKTREE_UNASSIGNED when no assignment for agent", async () => {
    const tool = createTool({
      agentId: "agent-99",
      pluginConfig: {
        assignments: { "agent-1": { worktreePath: WORKTREE, bareRepoPath: BARE } },
      },
    });
    const result = await tool.execute?.("t1", { targetBranch: "feat/x" });
    const details = (result as { details?: { errorCode?: string } })?.details;
    expect(details?.errorCode).toBe("AGENT_WORKTREE_UNASSIGNED");
  });

  it("fails AGENT_WORKTREE_INVALID when worktree not linked to bare", async () => {
    const mock = mockRunProcess([{ exitCode: 0, stdout: "/other/path.git" }]);
    const tool = createTool({
      agentId: "agent-1",
      pluginConfig: {
        assignments: { "agent-1": { worktreePath: WORKTREE, bareRepoPath: BARE } },
      },
      runProcess: mock.fn,
    });
    const result = await tool.execute?.("t1", { targetBranch: "feat/x" });
    const details = (result as { details?: { errorCode?: string } })?.details;
    expect(details?.errorCode).toBe("AGENT_WORKTREE_INVALID");
  });

  it("fails INVALID_BRANCH_NAME when branch name invalid", async () => {
    const mock = mockRunProcess([
      { exitCode: 0, stdout: BARE },
      { exitCode: 1, stderr: "invalid branch name" },
    ]);
    const tool = createTool({
      agentId: "agent-1",
      pluginConfig: {
        assignments: { "agent-1": { worktreePath: WORKTREE, bareRepoPath: BARE } },
      },
      runProcess: mock.fn,
    });
    const result = await tool.execute?.("t1", { targetBranch: "bad..branch" });
    const details = (result as { details?: { errorCode?: string } })?.details;
    expect(details?.errorCode).toBe("INVALID_BRANCH_NAME");
  });

  it("fails DIRTY_WORKTREE when status has file changes", async () => {
    const mock = mockRunProcess([
      { exitCode: 0, stdout: BARE },
      { exitCode: 0 },
      { exitCode: 0, stdout: "## main\n M file.txt\n" },
    ]);
    const tool = createTool({
      agentId: "agent-1",
      pluginConfig: {
        assignments: { "agent-1": { worktreePath: WORKTREE, bareRepoPath: BARE } },
      },
      runProcess: mock.fn,
    });
    const result = await tool.execute?.("t1", { targetBranch: "feat/x" });
    const details = (result as { details?: { errorCode?: string } })?.details;
    expect(details?.errorCode).toBe("DIRTY_WORKTREE");
  });

  it("fails NO_UPSTREAM when no upstream and ignoreNoUpstream=false", async () => {
    const mock = mockRunProcess([
      { exitCode: 0, stdout: BARE },
      { exitCode: 0 },
      { exitCode: 0, stdout: "## main\n" },
      { exitCode: 1, stdout: "" },
    ]);
    const tool = createTool({
      agentId: "agent-1",
      pluginConfig: {
        assignments: { "agent-1": { worktreePath: WORKTREE, bareRepoPath: BARE } },
      },
      runProcess: mock.fn,
    });
    const result = await tool.execute?.("t1", { targetBranch: "feat/x" });
    const details = (result as { details?: { errorCode?: string } })?.details;
    expect(details?.errorCode).toBe("NO_UPSTREAM");
  });

  it("continues when ignoreNoUpstream=true and no upstream", async () => {
    const mock = mockRunProcess([
      { exitCode: 0, stdout: BARE },
      { exitCode: 0 },
      { exitCode: 0, stdout: "## main\n" },
      { exitCode: 1, stdout: "" },
      { exitCode: 1 },
      { exitCode: 0 },
      { exitCode: 0, stdout: "feat/x" },
      { exitCode: 0, stdout: "abc123" },
    ]);
    const tool = createTool({
      agentId: "agent-1",
      pluginConfig: {
        assignments: { "agent-1": { worktreePath: WORKTREE, bareRepoPath: BARE } },
        allowedBaseRefs: ["origin/main"],
      },
      runProcess: mock.fn,
    });
    const result = await tool.execute?.("t1", {
      targetBranch: "feat/x",
      ignoreNoUpstream: true,
    });
    const details = (result as { details?: Record<string, unknown> })?.details;
    expect(details?.ok).toBe(true);
    expect(details?.ignoreNoUpstreamApplied).toBe(true);
  });

  it("fails UNPUSHED_COMMITS when ahead and ignoreUnpushed=false", async () => {
    const mock = mockRunProcess([
      { exitCode: 0, stdout: BARE },
      { exitCode: 0 },
      { exitCode: 0, stdout: "## main\n" },
      { exitCode: 0, stdout: "origin/main" },
      { exitCode: 0, stdout: "2\t0" },
    ]);
    const tool = createTool({
      agentId: "agent-1",
      pluginConfig: {
        assignments: { "agent-1": { worktreePath: WORKTREE, bareRepoPath: BARE } },
      },
      runProcess: mock.fn,
    });
    const result = await tool.execute?.("t1", { targetBranch: "feat/x" });
    const details = (result as { details?: { errorCode?: string } })?.details;
    expect(details?.errorCode).toBe("UNPUSHED_COMMITS");
  });

  it("continues when ignoreUnpushed=true and ahead", async () => {
    const mock = mockRunProcess([
      { exitCode: 0, stdout: BARE },
      { exitCode: 0 },
      { exitCode: 0, stdout: "## main\n" },
      { exitCode: 0, stdout: "origin/main" },
      { exitCode: 0, stdout: "2\t0" },
      { exitCode: 0 },
      { exitCode: 0, stdout: "feat/x" },
      { exitCode: 0, stdout: "abc123" },
    ]);
    const tool = createTool({
      agentId: "agent-1",
      pluginConfig: {
        assignments: { "agent-1": { worktreePath: WORKTREE, bareRepoPath: BARE } },
        allowedBaseRefs: ["origin/main"],
      },
      runProcess: mock.fn,
    });
    const result = await tool.execute?.("t1", {
      targetBranch: "feat/x",
      ignoreUnpushed: true,
    });
    const details = (result as { details?: Record<string, unknown> })?.details;
    expect(details?.ok).toBe(true);
    expect(details?.ignoreUnpushedApplied).toBe(true);
  });

  it("fails BRANCH_ALREADY_EXISTS when branchMode=create and branch exists", async () => {
    const mock = mockRunProcess([
      { exitCode: 0, stdout: BARE },
      { exitCode: 0 },
      { exitCode: 0, stdout: "## main\n" },
      { exitCode: 0, stdout: "origin/main" },
      { exitCode: 0, stdout: "0\t0" },
      { exitCode: 0 },
    ]);
    const tool = createTool({
      agentId: "agent-1",
      pluginConfig: {
        assignments: { "agent-1": { worktreePath: WORKTREE, bareRepoPath: BARE } },
      },
      runProcess: mock.fn,
    });
    const result = await tool.execute?.("t1", {
      targetBranch: "feat/x",
      branchMode: "create",
    });
    const details = (result as { details?: { errorCode?: string } })?.details;
    expect(details?.errorCode).toBe("BRANCH_ALREADY_EXISTS");
  });

  it("fails BRANCH_NOT_FOUND when branchMode=existing and branch missing", async () => {
    const mock = mockRunProcess([
      { exitCode: 0, stdout: BARE },
      { exitCode: 0 },
      { exitCode: 0, stdout: "## main\n" },
      { exitCode: 0, stdout: "origin/main" },
      { exitCode: 0, stdout: "0\t0" },
      { exitCode: 1 },
    ]);
    const tool = createTool({
      agentId: "agent-1",
      pluginConfig: {
        assignments: { "agent-1": { worktreePath: WORKTREE, bareRepoPath: BARE } },
      },
      runProcess: mock.fn,
    });
    const result = await tool.execute?.("t1", {
      targetBranch: "feat/x",
      branchMode: "existing",
    });
    const details = (result as { details?: { errorCode?: string } })?.details;
    expect(details?.errorCode).toBe("BRANCH_NOT_FOUND");
  });

  it("succeeds in auto mode when target exists (checkout existing)", async () => {
    const mock = mockRunProcess([
      { exitCode: 0, stdout: BARE },
      { exitCode: 0 },
      { exitCode: 0, stdout: "## main\n" },
      { exitCode: 0, stdout: "origin/main" },
      { exitCode: 0, stdout: "0\t0" },
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0, stdout: "feat/x" },
      { exitCode: 0, stdout: "abc123" },
    ]);
    const tool = createTool({
      agentId: "agent-1",
      pluginConfig: {
        assignments: { "agent-1": { worktreePath: WORKTREE, bareRepoPath: BARE } },
        allowedBaseRefs: ["origin/main"],
      },
      runProcess: mock.fn,
    });
    const result = await tool.execute?.("t1", { targetBranch: "feat/x" });
    const details = (result as { details?: Record<string, unknown> })?.details;
    expect(details?.ok).toBe(true);
    expect(details?.newBranch).toBe("feat/x");
    expect(details?.previousBranch).toBe("main");
  });

  it("succeeds in auto mode when target missing (checkout -b)", async () => {
    const mock = mockRunProcess([
      { exitCode: 0, stdout: BARE },
      { exitCode: 0 },
      { exitCode: 0, stdout: "## main\n" },
      { exitCode: 0, stdout: "origin/main" },
      { exitCode: 0, stdout: "0\t0" },
      { exitCode: 1 },
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0, stdout: "feat/new" },
      { exitCode: 0, stdout: "def456" },
    ]);
    const tool = createTool({
      agentId: "agent-1",
      pluginConfig: {
        assignments: { "agent-1": { worktreePath: WORKTREE, bareRepoPath: BARE } },
        allowedBaseRefs: ["origin/main"],
      },
      runProcess: mock.fn,
    });
    const result = await tool.execute?.("t1", { targetBranch: "feat/new" });
    const details = (result as { details?: Record<string, unknown> })?.details;
    expect(details?.ok).toBe(true);
    expect(details?.newBranch).toBe("feat/new");
  });

  it("fails BASE_REF_NOT_FOUND when baseRef not in allowedBaseRefs", async () => {
    const mock = mockRunProcess([
      { exitCode: 0, stdout: BARE },
      { exitCode: 0 },
      { exitCode: 0, stdout: "main" },
      { exitCode: 0, stdout: "## main\n" },
      { exitCode: 0, stdout: "origin/main" },
      { exitCode: 0, stdout: "0\t0" },
      { exitCode: 1 },
    ]);
    const tool = createTool({
      agentId: "agent-1",
      pluginConfig: {
        assignments: { "agent-1": { worktreePath: WORKTREE, bareRepoPath: BARE } },
        allowedBaseRefs: ["origin/main"],
      },
      runProcess: mock.fn,
    });
    const result = await tool.execute?.("t1", {
      targetBranch: "feat/x",
      baseRef: "origin/other",
    });
    const details = (result as { details?: { errorCode?: string } })?.details;
    expect(details?.errorCode).toBe("BASE_REF_NOT_FOUND");
  });

  it("fails CHECKOUT_FAILED when checkout returns non-zero", async () => {
    const mock = mockRunProcess([
      { exitCode: 0, stdout: BARE },
      { exitCode: 0 },
      { exitCode: 0, stdout: "main" },
      { exitCode: 0, stdout: "## main\n" },
      { exitCode: 0, stdout: "origin/main" },
      { exitCode: 0, stdout: "0\t0" },
      { exitCode: 0 },
      { exitCode: 1, stderr: "checkout failed" },
    ]);
    const tool = createTool({
      agentId: "agent-1",
      pluginConfig: {
        assignments: { "agent-1": { worktreePath: WORKTREE, bareRepoPath: BARE } },
        allowedBaseRefs: ["origin/main"],
      },
      runProcess: mock.fn,
    });
    const result = await tool.execute?.("t1", { targetBranch: "feat/x" });
    const details = (result as { details?: { errorCode?: string } })?.details;
    expect(details?.errorCode).toBe("CHECKOUT_FAILED");
  });

  it("fails VERIFY_FAILED when post-checkout verification mismatch", async () => {
    const mock = mockRunProcess([
      { exitCode: 0, stdout: BARE },
      { exitCode: 0 },
      { exitCode: 0, stdout: "main" },
      { exitCode: 0, stdout: "## main\n" },
      { exitCode: 0, stdout: "origin/main" },
      { exitCode: 0, stdout: "0\t0" },
      { exitCode: 0 },
      { exitCode: 0, stdout: "other-branch" },
      { exitCode: 0, stdout: "abc123" },
    ]);
    const tool = createTool({
      agentId: "agent-1",
      pluginConfig: {
        assignments: { "agent-1": { worktreePath: WORKTREE, bareRepoPath: BARE } },
        allowedBaseRefs: ["origin/main"],
      },
      runProcess: mock.fn,
    });
    const result = await tool.execute?.("t1", { targetBranch: "feat/x" });
    const details = (result as { details?: { errorCode?: string } })?.details;
    expect(details?.errorCode).toBe("VERIFY_FAILED");
  });

  it("fails BASE_REF_NOT_FOUND when base ref missing in git", async () => {
    const mock = mockRunProcess([
      { exitCode: 0, stdout: BARE },
      { exitCode: 0 },
      { exitCode: 0, stdout: "main" },
      { exitCode: 0, stdout: "## main\n" },
      { exitCode: 0, stdout: "origin/main" },
      { exitCode: 0, stdout: "0\t0" },
      { exitCode: 1 },
      { exitCode: 1, stderr: "fatal: bad revision" },
    ]);
    const tool = createTool({
      agentId: "agent-1",
      pluginConfig: {
        assignments: { "agent-1": { worktreePath: WORKTREE, bareRepoPath: BARE } },
        allowedBaseRefs: ["origin/main", "origin/other"],
      },
      runProcess: mock.fn,
    });
    const result = await tool.execute?.("t1", {
      targetBranch: "feat/x",
      baseRef: "origin/other",
    });
    const details = (result as { details?: { errorCode?: string } })?.details;
    expect(details?.errorCode).toBe("BASE_REF_NOT_FOUND");
  });

  it("fails AGENT_WORKTREE_INVALID when paths are non-absolute", async () => {
    const tool = createTool({
      agentId: "agent-1",
      pluginConfig: {
        assignments: { "agent-1": { worktreePath: "relative/path", bareRepoPath: BARE } },
      },
    });
    const result = await tool.execute?.("t1", { targetBranch: "feat/x" });
    const details = (result as { details?: { errorCode?: string } })?.details;
    expect(details?.errorCode).toBe("AGENT_WORKTREE_INVALID");
  });

  it("fails AGENT_WORKTREE_INVALID when rev-list fails", async () => {
    const mock = mockRunProcess([
      { exitCode: 0, stdout: BARE },
      { exitCode: 0 },
      { exitCode: 0, stdout: "main" },
      { exitCode: 0, stdout: "## main\n" },
      { exitCode: 0, stdout: "origin/main" },
      { exitCode: 1, stderr: "rev-list failed" },
    ]);
    const tool = createTool({
      agentId: "agent-1",
      pluginConfig: {
        assignments: { "agent-1": { worktreePath: WORKTREE, bareRepoPath: BARE } },
      },
      runProcess: mock.fn,
    });
    const result = await tool.execute?.("t1", { targetBranch: "feat/x" });
    const details = (result as { details?: { errorCode?: string } })?.details;
    expect(details?.errorCode).toBe("AGENT_WORKTREE_INVALID");
  });

  it("returns PROCESS_TIMEOUT when runProcess rejects with timeout", async () => {
    const runProcess = vi.fn().mockRejectedValue(
      new Error("Process timed out after 30s: git -C /foo rev-parse"),
    );
    const tool = createTool({
      agentId: "agent-1",
      pluginConfig: {
        assignments: { "agent-1": { worktreePath: WORKTREE, bareRepoPath: BARE } },
      },
      runProcess,
    });
    const result = await tool.execute?.("t1", { targetBranch: "feat/x" });
    const details = (result as { details?: { errorCode?: string } })?.details;
    expect(details?.errorCode).toBe("PROCESS_TIMEOUT");
  });

  it("ignoreUnpushedApplied false when no unpushed commits (flag set but not bypassed)", async () => {
    const mock = mockRunProcess([
      { exitCode: 0, stdout: BARE },
      { exitCode: 0 },
      { exitCode: 0, stdout: "main" },
      { exitCode: 0, stdout: "## main\n" },
      { exitCode: 0, stdout: "origin/main" },
      { exitCode: 0, stdout: "0\t0" },
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0, stdout: "feat/x" },
      { exitCode: 0, stdout: "abc123" },
    ]);
    const tool = createTool({
      agentId: "agent-1",
      pluginConfig: {
        assignments: { "agent-1": { worktreePath: WORKTREE, bareRepoPath: BARE } },
        allowedBaseRefs: ["origin/main"],
      },
      runProcess: mock.fn,
    });
    const result = await tool.execute?.("t1", {
      targetBranch: "feat/x",
      ignoreUnpushed: true,
    });
    const details = (result as { details?: Record<string, unknown> })?.details;
    expect(details?.ok).toBe(true);
    expect(details?.ignoreUnpushedApplied).toBe(false);
  });

  it("guard: never invokes real process when mock provided", async () => {
    const mock = mockRunProcess([
      { exitCode: 0, stdout: BARE },
      { exitCode: 0 },
      { exitCode: 0, stdout: "## main\n" },
      { exitCode: 0, stdout: "origin/main" },
      { exitCode: 0, stdout: "0\t0" },
      { exitCode: 1 },
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0, stdout: "feat/x" },
      { exitCode: 0, stdout: "abc" },
    ]);
    const tool = createTool({
      agentId: "agent-1",
      pluginConfig: {
        assignments: { "agent-1": { worktreePath: WORKTREE, bareRepoPath: BARE } },
        allowedBaseRefs: ["origin/main"],
      },
      runProcess: mock.fn,
    });
    await tool.execute?.("t1", { targetBranch: "feat/x" });
    expect(mock.fn).toHaveBeenCalled();
    const calls = mock.fn.mock.calls as string[][];
    expect(calls.every((c) => c[0] === "git")).toBe(true);
  });
});
