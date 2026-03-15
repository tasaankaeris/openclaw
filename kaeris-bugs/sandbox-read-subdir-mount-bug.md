# Bug: Read tool fails for subdirectory mounted read-only via separate Docker mount

## Scenario

- Workspace in the sandboxed container is mapped (e.g. host `workspaceDir` → container `/workspace`).
- A **subdirectory** of the workspace is also mapped into the container **read-only** via a **separate** Docker bind mount (e.g. host `/other/readonly` → container `/workspace/subdir`).
- Reading files under the main workspace via the read tool **works**.
- Reading files under the mounted subdirectory via the read tool **fails** with a "path escapes sandbox mount root" style error, even though the path is inside the workspace and inside an allowed mount.

So the path does **not** escape the sandbox; the failure is a bug in how host path resolution and mount-based safety checks interact.

---

## Root cause

Two different resolution strategies are used, and they disagree when a **host path** is resolved first and a **container-path-based** safety check is applied later.

### 1. How the read tool gets the path

- The sandboxed read tool is built with `createReadTool(params.root, { operations: createSandboxReadOperations(params) })` where `params.root` is the **host** workspace dir.
- The coding agent's read tool resolves the user path (e.g. `subdir/file` or `/workspace/subdir/file`) relative to `root` and passes a single **host absolute path** to the bridge: `operations.readFile(absolutePath)` with `absolutePath = path.resolve(root, ...)` (e.g. `workspaceDir/subdir/file`).
- So the bridge always receives a **host path** for reads, not a container path.

### 2. Host-path resolution in `resolveSandboxFsPathWithMounts`

In `src/agents/sandbox/fs-paths.ts`:

- If the input looks like a **posix absolute path** and matches a **container** root, it's resolved by **container** path (lines 110–129): the correct mount is chosen (e.g. the bind at `/workspace/subdir`), and the correct **host** path is derived from that mount.
- For the path we actually pass, the input is a **host** path (e.g. `workspaceDir/subdir/file` or `/home/user/workspace/subdir/file`). It does **not** match any `containerRoot` (those are like `/workspace`, `/workspace/subdir`), so the container-path branch is skipped.
- Resolution then uses the **host-path** branch (lines 132–149): `resolveSandboxInputPath` keeps it as-is, `findMountByHostPath(mountsByHost, hostResolved)` finds the **workspace** mount (the only one whose `hostRoot` contains `workspaceDir/subdir/file`). The bind mount has a **different** `hostRoot` (`/other/readonly`), so it is not considered.
- So the function returns:
  - `hostPath` = `workspaceDir/subdir/file`
  - `containerPath` = `/workspace/subdir/file`
  - and attributes the path to the **workspace** mount.

So for a path under the bind-mounted subdirectory, we still resolve it as if it lived under the main workspace mount and return the host path under `workspaceDir`, even though in the container that location is shadowed by the bind.

### 3. Safety check uses container path and a different mount

In `src/agents/sandbox/fs-bridge.ts`, `assertPathSafety`:

- Takes the resolved `target` (with `hostPath` and `containerPath` from the step above).
- Finds the mount by **container** path: `resolveMountByContainerPath(target.containerPath)`. Mounts are ordered by **longest** `containerRoot` first, so `/workspace/subdir/file` is matched to the **bind** mount (`/workspace/subdir`), not the workspace mount (`/workspace`).
- It then enforces that `target.hostPath` is under **that** mount's `hostRoot` via `openBoundaryFile(absolutePath: target.hostPath, rootPath: lexicalMount.hostRoot, ...)`.
- So it checks: "is `workspaceDir/subdir/file` under `lexicalMount.hostRoot`?" where `lexicalMount.hostRoot` is the bind's host path (e.g. `/other/readonly`). It is **not** under that root, so the boundary check fails and we get "path escapes sandbox mount root" (or equivalent).

So:

- **Resolution** chose the workspace mount (by host path) and returned a host path under `workspaceDir`.
- **Safety** chose the bind mount (by container path) and required the path to be under the bind's host root.
- The returned host path was never rewritten to the bind's host path, so the check is inconsistent and fails even though the requested path is valid and under an allowed mount.

---

## Summary

| Step | What happens | Problem |
|------|----------------|--------|
| Read tool | Passes **host** path `workspaceDir/subdir/file` to the bridge. | Correct for a single-mount world; wrong when a subdir is a separate mount. |
| `resolveSandboxFsPathWithMounts` | Resolves by **host** path; only the workspace mount matches; returns that host path + container path `/workspace/subdir/file`. | Host path is never rewritten to the bind's host path. |
| `assertPathSafety` | Finds mount by **container** path → bind mount; checks that returned host path is under bind's `hostRoot`. | Fails because returned host path is still under workspace dir, not under bind's host root. |

So the path does **not** escape the sandbox; the logic mixes "resolve by host path" with "check by container path" and never rewrites the host path when the container path is actually served by a different (more specific) mount.

---

## Fix direction

- **Option A (recommended):** In `resolveSandboxFsPathWithMounts`, after resolving by host path (and getting a `containerPath`), check whether that `containerPath` lies under a **more specific** mount (longer `containerRoot`) than the one used for host resolution. If so, re-resolve the **host** path from that more specific mount (same relative path under its `hostRoot`) and return that host path. Then resolution and safety both agree on the same mount and the boundary check passes.
- **Option B:** Have the sandboxed read tool pass **container** path (or a path that the bridge can interpret as container path) when the agent's path is under the container workdir, so the bridge consistently resolves by container path and gets the correct mount and host path in one place. This may require the read tool (or its wrapper) to pass through container paths and the bridge to accept them.

Option A keeps the current "bridge receives host path" contract and fixes the inconsistency inside `resolveSandboxFsPathWithMounts` by aligning the returned host path with the mount that actually serves the container path.

---

## 1. Fix without source changes?

**Not feasible.** The bug is in how the bridge resolves a host path and then which mount is used for the safety check; that logic is fixed in code. No config or Docker option changes that.

**Workaround only:** Avoid the scenario.

- **Option (a):** Don't use a separate bind for the subdirectory. Make the read-only content part of the main workspace on the host (e.g. the host workspace dir already contains that tree, or copy it in, or a symlink under the workspace). Then there's only one mount and the bug doesn't trigger.
- **Option (b):** Don't read from the bind-mounted subdirectory via the read tool (e.g. document that that area is not readable by the agent, or use another mechanism).

So you can only "fix" it without source by not having a separate bind for a workspace subdirectory that the read tool must access, or by not reading there.

---

## 2. Bare minimum source fix

**Single place, small change:** `src/agents/sandbox/fs-paths.ts`, inside `resolveSandboxFsPathWithMounts`, in the **host-path resolution branch** (the block that runs after the absolute-container-path branch, where we have `hostMount` and compute `hostPath`, `containerPath`).

**Add:** After computing `containerPath` from the host mount, resolve the mount again by **container** path (using the same sorted list used for the absolute-path branch: longest `containerRoot` first). If that mount is **different** from `hostMount` (i.e. a more specific mount shadows this path in the container), recompute:

- `hostPath` = that mount's `hostRoot` + relative path from that mount's `containerRoot` to `containerPath` (using existing `toHostSegments` / `path.resolve`),
- and use that mount's `writable` for the returned result.

**Why this is enough:** Resolution and safety then agree on the same mount; the returned `hostPath` is under the same mount's `hostRoot` that `assertPathSafety` will use, so the boundary check passes. No changes to the read tool, bridge API, or `assertPathSafety`; only `resolveSandboxFsPathWithMounts` is updated.

---

## Fix applied (history)

**Repository:** [tasaankaeris/openclaw](https://github.com/tasaankaeris/openclaw) (origin)  
**File:** [src/agents/sandbox/fs-paths.ts](https://github.com/tasaankaeris/openclaw/blob/main/src/agents/sandbox/fs-paths.ts)

**Exact lines changed** (host-path resolution branch of `resolveSandboxFsPathWithMounts`):

- [Lines 140–158](https://github.com/tasaankaeris/openclaw/blob/main/src/agents/sandbox/fs-paths.ts#L140-L158): after computing `containerPath` from `hostMount`, resolve the mount by container path; if a more specific mount shadows, recompute `hostPath` and use that mount’s `writable`.

**What the fix does:**

1. After computing `containerPath` (unchanged: from `hostMount` + relative host path), call `findMountByContainerPath(mountsByContainer, containerPath)` so the effective mount matches what `assertPathSafety` will use in the bridge (longest `containerRoot` first).
2. If that mount is different from `hostMount`, use it: set `mount = containerMount`, and set `hostPath = path.resolve(mount.hostRoot, ...toHostSegments(path.posix.relative(mount.containerRoot, containerPath)))`. Otherwise keep `mount = hostMount` and `hostPath = hostResolved`.
3. Return `writable: mount.writable` so read-only binds are respected.

Resolution and safety now agree on the same mount; the returned `hostPath` lies under the same `hostRoot` that `openBoundaryFile` checks in `assertPathSafety`, so the “path escapes sandbox mount root” error no longer occurs for valid paths under a bind-mounted subdirectory.
