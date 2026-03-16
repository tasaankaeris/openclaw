import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import path from "node:path";
import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk";

const GIT_PROCESS_TIMEOUT_MS = 30_000;

export type RunProcessFn = (
  argv: string[],
  options?: { cwd?: string },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/** Default process runner: spawns with argv, no shell. Times out after 30s. */
export async function runProcessDefault(
  argv: string[],
  options?: { cwd?: string },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = argv;
    const proc = spawn(cmd, args, {
      cwd: options?.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (result: { exitCode: number; stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill("SIGKILL");
      clearTimeout(timer);
      reject(
        new Error(
          `Process timed out after ${GIT_PROCESS_TIMEOUT_MS / 1000}s: ${cmd} ${args.join(" ")}`,
        ),
      );
    }, GIT_PROCESS_TIMEOUT_MS);
    proc.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    proc.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    proc.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const exitCode = code ?? (signal ? 128 + 15 : 1);
      resolve({ exitCode, stdout, stderr });
    });
  });
}

const BRANCH_MODES = ["auto", "create", "existing"] as const;
type BranchMode = (typeof BRANCH_MODES)[number];

const branchModeSchema = Type.Unsafe<BranchMode>({
  type: "string",
  enum: [...BRANCH_MODES],
  description: "Branch mode: auto (try existing then create), create (require new), existing (require exists).",
});

const WorktreeSwapSchema = Type.Object(
  {
    targetBranch: Type.String({ description: "Target branch name to switch to or create." }),
    baseRef: Type.Optional(
      Type.String({ description: "Base ref for branch creation (default: origin/main)." }),
    ),
    branchMode: Type.Optional(branchModeSchema),
    ignoreUnpushed: Type.Optional(
      Type.Boolean({
        description: "If true, allow swap when current branch has unpushed commits.",
      }),
    ),
    ignoreNoUpstream: Type.Optional(
      Type.Boolean({
        description: "If true, allow swap when current branch has no upstream.",
      }),
    ),
  },
  { additionalProperties: false },
);

type WorktreeSwapParams = {
  targetBranch: string;
  baseRef?: string;
  branchMode?: BranchMode;
  ignoreUnpushed?: boolean;
  ignoreNoUpstream?: boolean;
};

type WorktreePluginConfig = {
  assignments?: Record<
    string,
    { worktreePath: string; bareRepoPath: string }
  >;
  allowedBaseRefs?: string[];
};

const ERROR_CODES = [
  "CALLER_ID_MISSING",
  "AGENT_WORKTREE_UNASSIGNED",
  "AGENT_WORKTREE_INVALID",
  "DIRTY_WORKTREE",
  "UNPUSHED_COMMITS",
  "NO_UPSTREAM",
  "INVALID_BRANCH_NAME",
  "BASE_REF_NOT_FOUND",
  "BRANCH_ALREADY_EXISTS",
  "BRANCH_NOT_FOUND",
  "CHECKOUT_FAILED",
  "VERIFY_FAILED",
  "PROCESS_TIMEOUT",
] as const;

type ErrorCode = (typeof ERROR_CODES)[number];

function err(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): { errorCode: ErrorCode; noChangeApplied: true; message: string; details?: Record<string, unknown> } {
  return { errorCode: code, noChangeApplied: true, message, details };
}

function isAbsolutePosixPath(p: string): boolean {
  const n = p.replace(/\\/g, "/").trim();
  return n.startsWith("/") && n.length > 1;
}

function resolveAgentId(ctx: OpenClawPluginToolContext): string | undefined {
  const id = ctx.agentId?.trim();
  if (id) return id;
  const key = ctx.sessionKey?.trim();
  if (key && key.startsWith("agent:")) {
    const parts = key.split(":");
    return parts[1]?.trim();
  }
  return undefined;
}

export function createWorktreeSwapTool(opts: {
  api: { pluginConfig?: Record<string, unknown> };
  ctx: OpenClawPluginToolContext;
  runProcess?: RunProcessFn;
}): AnyAgentTool {
  const runProcess = opts.runProcess ?? runProcessDefault;
  const pluginCfg = (opts.api.pluginConfig ?? {}) as WorktreePluginConfig;
  const assignments = pluginCfg.assignments ?? {};
  const allowedBaseRefs = new Set(pluginCfg.allowedBaseRefs ?? ["origin/main"]);
  const toolCtx = opts.ctx;

  return {
    name: "worktree_swap_branch",
    label: "Worktree Swap Branch",
    description:
      "Switch the assigned worktree to a target branch. Creates the branch from baseRef if missing (auto mode). Enforces clean tree and optional upstream/unpushed guards.",
    parameters: WorktreeSwapSchema,
    execute: async (_toolCallId, rawParams) => {
      try {
        return await executeWorktreeSwap(rawParams, runProcess, assignments, allowedBaseRefs, toolCtx);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("timed out")) {
          return {
            content: [{ type: "text", text: "Git process timed out." }],
            details: err("PROCESS_TIMEOUT", msg),
          };
        }
        throw e;
      }
    },
  };
}

async function executeWorktreeSwap(
  rawParams: unknown,
  runProcess: RunProcessFn,
  assignments: Record<string, { worktreePath: string; bareRepoPath: string }>,
  allowedBaseRefs: Set<string>,
  toolCtx: OpenClawPluginToolContext,
): Promise<{ content: unknown[]; details: unknown }> {
  const params = rawParams as WorktreeSwapParams;
  const targetBranch = params.targetBranch?.trim() ?? "";
  const baseRef = params.baseRef?.trim() || "origin/main";
  const branchMode: BranchMode = params.branchMode ?? "auto";
  const ignoreUnpushed = params.ignoreUnpushed === true;
  const ignoreNoUpstream = params.ignoreNoUpstream === true;

  const agentId = resolveAgentId(toolCtx);
  if (!agentId) {
    return {
      content: [{ type: "text", text: "Caller identity could not be resolved." }],
      details: err("CALLER_ID_MISSING", "Runtime context did not provide a resolvable agent identity."),
    };
  }

  const assignment = assignments[agentId];
  if (!assignment?.worktreePath || !assignment?.bareRepoPath) {
    return {
      content: [{ type: "text", text: "No worktree assignment for this agent." }],
      details: err("AGENT_WORKTREE_UNASSIGNED", "Caller agent has no configured worktree/bare-repo mapping."),
    };
  }

  const worktreePath = assignment.worktreePath.replace(/\\/g, "/").trim();
  const bareRepoPath = assignment.bareRepoPath.replace(/\\/g, "/").trim();

  if (!isAbsolutePosixPath(worktreePath) || !isAbsolutePosixPath(bareRepoPath)) {
    return {
      content: [{ type: "text", text: "Paths must be absolute POSIX paths." }],
      details: err("AGENT_WORKTREE_INVALID", "Assigned paths must be absolute POSIX paths."),
    };
  }

  if (!targetBranch) {
    return {
      content: [{ type: "text", text: "targetBranch is required and must be non-empty." }],
      details: err("INVALID_BRANCH_NAME", "Target branch name is empty."),
    };
  }

  const git = (args: string[], cwd: string) =>
    runProcess(["git", "-C", cwd, ...args], { cwd });

  const revParse = async (args: string[]) => {
    const r = await git(["rev-parse", ...args], worktreePath);
    return { ...r, out: r.stdout.trim() };
  };

  const gitCommonDir = await revParse(["--git-common-dir"]);
  if (gitCommonDir.exitCode !== 0) {
    return {
      content: [{ type: "text", text: "Worktree is not a valid git worktree." }],
      details: err("AGENT_WORKTREE_INVALID", "Assigned worktree is missing or not linked to bare repo.", {
        stderr: gitCommonDir.stderr.slice(0, 200),
      }),
    };
  }

  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "") || p;
  const resolvedCommonDir = path.resolve(worktreePath, gitCommonDir.out);
  const normalizedCommonDir = norm(resolvedCommonDir);
  const normalizedBare = norm(bareRepoPath);
  if (normalizedCommonDir !== normalizedBare) {
    return {
      content: [{ type: "text", text: "Worktree is not linked to configured bare repo." }],
      details: err("AGENT_WORKTREE_INVALID", "Assigned worktree is not linked to configured bare repo."),
    };
  }

  const checkRefFormat = await git(["check-ref-format", "--branch", targetBranch], worktreePath);
  if (checkRefFormat.exitCode !== 0) {
    return {
      content: [{ type: "text", text: "Invalid branch name per git rules." }],
      details: err("INVALID_BRANCH_NAME", "Branch name fails git check-ref-format.", {
        stderr: checkRefFormat.stderr.slice(0, 200),
      }),
    };
  }

  const headRef = await revParse(["--abbrev-ref", "HEAD"]);
  const previousBranch = headRef.exitCode === 0 ? headRef.out : "unknown";

  const statusResult = await git(["status", "--porcelain", "--branch"], worktreePath);
  if (statusResult.exitCode !== 0) {
    return {
      content: [{ type: "text", text: "Failed to read worktree status." }],
      details: err("AGENT_WORKTREE_INVALID", "Could not read worktree status.", {
        stderr: statusResult.stderr.slice(0, 200),
      }),
    };
  }

  const statusLines = statusResult.stdout.split("\n");
  const hasFileChanges = statusLines.some((line) => line.trim().length > 0 && !line.startsWith("##"));
  if (hasFileChanges) {
    return {
      content: [
        {
          type: "text",
          text: "Worktree has uncommitted changes. Commit, stash, or discard before swapping branches.",
        },
      ],
      details: err("DIRTY_WORKTREE", "Local changes detected; no branch switch attempted."),
    };
  }

  const upstreamResult = await revParse(["--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  const hasUpstream = upstreamResult.exitCode === 0 && upstreamResult.out.length > 0;

  let unpushedBypass = false;
  let noUpstreamBypass = false;

  if (!hasUpstream) {
    if (!ignoreNoUpstream) {
      return {
        content: [
          {
            type: "text",
            text: "Current branch has no upstream. Set upstream or use ignoreNoUpstream=true.",
          },
        ],
        details: err("NO_UPSTREAM", "Current branch has no upstream and ignoreNoUpstream=false."),
      };
    }
    noUpstreamBypass = true;
  } else {
    const countResult = await git(
      ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
      worktreePath,
    );
    if (countResult.exitCode !== 0) {
      return {
        content: [{ type: "text", text: "Could not verify upstream/HEAD relationship." }],
        details: err("AGENT_WORKTREE_INVALID", "rev-list failed; cannot safely proceed.", {
          stderr: countResult.stderr.slice(0, 200),
        }),
      };
    }
    const parts = countResult.stdout.trim().split(/\s+/);
    // `git rev-list --left-right --count A...B` returns: "<left_count>\t<right_count>".
    // With "@{upstream}...HEAD", right_count is commits ahead of upstream.
    const ahead = parseInt(parts[1] ?? "0", 10) || 0;
    if (ahead > 0 && !ignoreUnpushed) {
      return {
        content: [
          {
            type: "text",
            text: "Current branch has unpushed commits. Push or use ignoreUnpushed=true.",
          },
        ],
        details: err("UNPUSHED_COMMITS", "Local branch is ahead of upstream and ignoreUnpushed=false."),
      };
    }
    if (ahead > 0 && ignoreUnpushed) {
      unpushedBypass = true;
    }
  }

  const branchExistsResult = await git(["show-ref", "--verify", "--quiet", `refs/heads/${targetBranch}`], worktreePath);
  const targetExists = branchExistsResult.exitCode === 0;

  if (branchMode === "create" && targetExists) {
    return {
      content: [{ type: "text", text: "Branch already exists; branchMode=create requires a new branch." }],
      details: err("BRANCH_ALREADY_EXISTS", "branchMode=create requested a branch that already exists."),
    };
  }

  if (branchMode === "existing" && !targetExists) {
    return {
      content: [{ type: "text", text: "Branch does not exist; branchMode=existing requires it." }],
      details: err("BRANCH_NOT_FOUND", "branchMode=existing requested a branch that does not exist."),
    };
  }

  const willCreate = !targetExists && (branchMode === "create" || branchMode === "auto");
  if (willCreate) {
    if (!allowedBaseRefs.has(baseRef)) {
      return {
        content: [{ type: "text", text: `Base ref ${baseRef} is not in allowedBaseRefs.` }],
        details: err("BASE_REF_NOT_FOUND", `Base ref ${baseRef} is not allowed.`),
      };
    }
    const baseExistsResult = await git(["rev-parse", "--verify", baseRef], worktreePath);
    if (baseExistsResult.exitCode !== 0) {
      return {
        content: [{ type: "text", text: `Base ref ${baseRef} not found.` }],
        details: err("BASE_REF_NOT_FOUND", `Requested baseRef ${baseRef} is missing.`, {
          stderr: baseExistsResult.stderr.slice(0, 200),
        }),
      };
    }
  }

  let checkoutResult: { exitCode: number; stdout: string; stderr: string };
  if (targetExists) {
    checkoutResult = await git(["checkout", targetBranch], worktreePath);
  } else {
    checkoutResult = await git(["checkout", "-b", targetBranch, baseRef], worktreePath);
  }

  if (checkoutResult.exitCode !== 0) {
    return {
      content: [{ type: "text", text: "Git checkout failed." }],
      details: err("CHECKOUT_FAILED", "Git checkout returned non-zero.", {
        stderr: checkoutResult.stderr.slice(0, 200),
      }),
    };
  }

  const verifyBranch = await revParse(["--abbrev-ref", "HEAD"]);
  const verifySha = await revParse(["HEAD"]);
  if (verifyBranch.exitCode !== 0 || verifyBranch.out !== targetBranch) {
    return {
      content: [{ type: "text", text: "Post-checkout verification failed." }],
      details: err("VERIFY_FAILED", "Post-checkout branch/sha verification mismatch."),
    };
  }

  const newHeadSha = verifySha.exitCode === 0 ? verifySha.out : "unknown";

  const warnings: string[] = [];
  if (unpushedBypass) warnings.push("ignoreUnpushed was used to bypass unpushed-commits guard.");
  if (noUpstreamBypass) warnings.push("ignoreNoUpstream was used to bypass no-upstream guard.");

  return {
    content: [
      {
        type: "text",
        text: `Swapped from ${previousBranch} to ${targetBranch}. HEAD: ${newHeadSha}`,
      },
    ],
    details: {
      ok: true,
      noChangeApplied: false,
      previousBranch,
      newBranch: targetBranch,
      newHeadSha,
      agentId,
      worktreePath,
      ignoreUnpushedApplied: unpushedBypass,
      ignoreNoUpstreamApplied: noUpstreamBypass,
      warnings: warnings.length > 0 ? warnings : undefined,
    },
  };
}
