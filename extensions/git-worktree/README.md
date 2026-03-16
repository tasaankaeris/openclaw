# Git Worktree Extension

Safe worktree branch-swap tool for sandboxed agents. Switches an assigned worktree to a target branch with strict validation. v1 supports branch swapping only; no worktree add/remove/prune.

## Prerequisites

### Mount contract

Each sandboxed agent container must use canonical absolute paths (example root: `/home/openclaw/.openclaw`):

- **Bare repo**: `/home/openclaw/.openclaw/repos/<repo>.git`
- **Per-agent worktree**: `/home/openclaw/.openclaw/worktrees/<agent-id>`

### Path consistency

Host and container paths for the mounted bare repo and worktree must be **identical** absolute paths. No path drift between host and container.

### Sandbox configuration

- Mount the assigned worktree and bare repo paths into the container via `sandbox.docker.binds`
- `sandbox.workspaceAccess`: keep minimal (`none` or `ro`) unless broader access is required
- `sandbox.docker.workdir`: optional; the tool uses configured `worktreePath` via `git -C`

## Configuration

```yaml
plugins:
  config:
    git-worktree:
      assignments:
        agent-1:
          worktreePath: /home/openclaw/.openclaw/worktrees/agent-1
          bareRepoPath: /home/openclaw/.openclaw/repos/openclaw.git
      allowedBaseRefs: [origin/main]
```

| Property | Description |
|----------|-------------|
| `assignments` | Map of agent ID to `worktreePath` and `bareRepoPath` |
| `allowedBaseRefs` | Refs allowed as base when creating new branches (default: `["origin/main"]`) |

## Tool: `worktree_swap_branch`

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `targetBranch` | string | Yes | Branch name to switch to or create |
| `baseRef` | string | No | Base ref for branch creation (default: `origin/main`) |
| `branchMode` | `auto` \| `create` \| `existing` | No | `auto`: try existing then create; `create`: require new; `existing`: require exists |
| `ignoreUnpushed` | boolean | No | Allow swap when current branch has unpushed commits (default: false) |
| `ignoreNoUpstream` | boolean | No | Allow swap when current branch has no upstream (default: false) |

### Behavior

1. Switches to existing `targetBranch`, or creates it from `baseRef` when missing (in `auto` mode)
2. Enforces clean worktree (no uncommitted changes)
3. Enforces upstream/ahead guards unless overridden by ignore flags
4. Returns structured response with previous branch, new branch, HEAD SHA, and warnings

### Error codes

| Code | Meaning |
|------|---------|
| `CALLER_ID_MISSING` | Runtime context did not provide agent identity |
| `AGENT_WORKTREE_UNASSIGNED` | Caller has no configured worktree assignment |
| `AGENT_WORKTREE_INVALID` | Worktree missing or not linked to configured bare repo |
| `DIRTY_WORKTREE` | Uncommitted changes; no branch switch |
| `UNPUSHED_COMMITS` | Branch ahead of upstream and `ignoreUnpushed=false` |
| `NO_UPSTREAM` | Branch has no upstream and `ignoreNoUpstream=false` |
| `INVALID_BRANCH_NAME` | Branch name fails git check-ref-format |
| `BASE_REF_NOT_FOUND` | Requested baseRef missing or not allowed |
| `BRANCH_ALREADY_EXISTS` | `branchMode=create` but branch exists |
| `BRANCH_NOT_FOUND` | `branchMode=existing` but branch does not exist |
| `CHECKOUT_FAILED` | Git checkout returned non-zero |
| `VERIFY_FAILED` | Post-checkout verification mismatch |
| `PROCESS_TIMEOUT` | Git subprocess timed out |

## Unsupported in v1

- `git worktree add` / `remove` / `prune`
- Read-only helper tools (`worktree_get_status`, `worktree_list_slots`)
- Branch pruning (operator maintenance only)

## Example

```yaml
agents:
  list:
    - id: agent-1
      sandbox:
        mode: all
        workspaceAccess: none
        docker:
          workdir: /home/openclaw/.openclaw/worktrees/agent-1
          binds:
            - /home/openclaw/.openclaw/worktrees/agent-1:/home/openclaw/.openclaw/worktrees/agent-1:rw
            - /home/openclaw/.openclaw/repos/openclaw.git:/home/openclaw/.openclaw/repos/openclaw.git:rw
plugins:
  config:
    git-worktree:
      assignments:
        agent-1:
          worktreePath: /home/openclaw/.openclaw/worktrees/agent-1
          bareRepoPath: /home/openclaw/.openclaw/repos/openclaw.git
      allowedBaseRefs: [origin/main]
```
