---
name: Discord Attachment Hydration
overview: Change `discord-thread-read` attachment behavior to single-switch hydration via `includeAttachments`, writing downloaded files to `media/inbound` in the agent workspace and returning caller-usable local paths.
todos:
  - id: update-read-contract
    content: Make `includeAttachments` the single switch for metadata + hydration and update tool docs/schema accordingly.
    status: pending
  - id: implement-hydration
    content: Implement attachment hydration in discord-thread read helpers with partial-success result shape and logger-based error reporting.
    status: pending
  - id: sandbox-path-mapping
    content: Save to agent workspace `media/inbound` and return sandbox/non-sandbox caller-usable paths.
    status: pending
  - id: retry-policy
    content: Add bounded download retries for 429/503/504 and transient network errors, honoring Retry-After where present.
    status: pending
  - id: deterministic-cache
    content: Add deterministic URL-hash keyed hydration reuse and a tool-level forceReDownload flag.
    status: pending
  - id: tests-hydration
    content: Add tests for contract semantics, retry behavior, and path mapping with one-shot file writes.
    status: pending
  - id: docs-contract
    content: Update in-file docs/comments to reflect single-switch hydration contract and failure signaling.
    status: pending
isProject: false
---

# Make includeAttachments Hydrate Attachments

## Goal

Eliminate the sandbox gap where CDN URLs are not directly readable by making `includeAttachments=true` return attachment metadata plus hydrated local files in one call.

## Scope and Behavior

- Keep `includeAttachments` default `false`.
- Change semantics: `includeAttachments=true` means metadata + hydration attempt in one pass (single switch; no second boolean).
- Enforce hydration window cap: when `includeAttachments=true`, `limit` must be `<= 5`; otherwise return validation error.
- Add tool-level `forceReDownload` (default `false`) for hydration calls.
- Hydrated files are written under `media/inbound` in the **agent workspace**.
- Returned attachment objects include metadata and `localPath` when hydration succeeds.
- Attachment-level hydration failures are represented as `hydrationFailure: true` on that attachment object (same level as `localPath`).
- Hydration uses deterministic URL-hash keyed cache identity so repeat reads reuse existing files by default instead of re-downloading.
- Hydration errors are logged with the existing logger and **not** surfaced as detailed per-attachment errors to callers.
- Do not add additional OpenClaw-specific file size/type caps beyond existing Discord/API behavior (per your direction).

## Implementation Plan

- Update tool schema and execution path in [extensions/discord-thread-tools/index.ts](extensions/discord-thread-tools/index.ts):
  - Keep current parameters; no new hydration flag.
  - Update `includeAttachments` description to reflect hydration semantics.
  - Add validation: if `includeAttachments=true` and `limit>5`, throw clear validation error before any network or file operations.
  - Add `forceReDownload` boolean parameter (default `false`) to control deterministic cache bypass.
  - Keep default behavior (`includeAttachments=false`) unchanged.
- Extend read helper types + projection in [extensions/discord-thread-tools/src/discord-thread-helpers.ts](extensions/discord-thread-tools/src/discord-thread-helpers.ts):
  - Add attachment output fields for local materialization and concise failure signaling (`localPath`, `hydrationFailure?: true`).
  - Implement hydration helper that downloads and writes to `<agentWorkspace>/media/inbound`.
  - Use URL hash as the **sole cache key** (filename identity); sanitized original names may be kept as display/context but must not affect cache identity.
  - If matching hydrated file already exists and `forceReDownload=false`, skip network fetch and reuse local file.
  - If `forceReDownload=true`, always fetch again and overwrite/refresh deterministic target.
  - Return sandbox-usable relative paths (`media/inbound/...`) for sandboxed callers and workspace-usable paths for non-sandbox callers.
  - Keep hydration non-fatal: message reads still succeed even if some attachments fail to hydrate.
  - On hydration failures, log full error details to existing logger and set only attachment-level `hydrationFailure: true` (no verbose error payload to caller).
- Add retry policy to hydration download path:
  - Retry on HTTP 429, 503, 504, and transient network errors.
  - Honor `Retry-After` header when present (especially 429/503).
  - Use bounded attempts and backoff.
  - Keep file writes one-shot (no write retries).
- Add/adjust tests in [extensions/discord-thread-tools/src/discord-thread-helpers.test.ts](extensions/discord-thread-tools/src/discord-thread-helpers.test.ts):
  - Existing `includeAttachments=false` behavior remains valid.
  - New coverage for `includeAttachments=true`:
    - successful hydration adds `localPath`,
    - mixed success/failure still returns messages and successful `localPath`s,
    - failed attachments set `hydrationFailure: true` at attachment level,
    - path shaping works in sandbox/non-sandbox contexts.
  - Validation coverage:
    - `includeAttachments=true` with `limit>5` returns validation error and performs no hydration work.
    - `includeAttachments=true` with `aroundMessageId` and `limit=1` supports “fetch one specific message attachment” workflow.
  - Deterministic cache coverage:
    - repeat read with same URL reuses existing file and avoids fetch,
    - `forceReDownload=true` bypasses reuse and fetches again.
  - Retry-specific coverage:
    - 429/503 with `Retry-After`,
    - 504 retry path,
    - transient network error retry path.
  - Confirm write failures are one-shot and summarized via `hydrationFailure`.
- Update extension docs/comments where contract is currently “URLs only”:
  - [extensions/discord-thread-tools/index.ts](extensions/discord-thread-tools/index.ts)
  - [extensions/discord-thread-tools/src/discord-thread-helpers.ts](extensions/discord-thread-tools/src/discord-thread-helpers.ts)
  - Clarify that `includeAttachments` is single-switch hydration (default false), with attachment-level `hydrationFailure: true` and logger-first failure detail.

## Design Notes

- There are no existing callers, so single-switch semantics optimize for first-try success in sandboxed environments.
- This removes the “web_fetch → write → read” workaround and avoids requiring two booleans.
- Recommended “specific attachment” flow: call `discord-thread-read` with `aroundMessageId=<targetMessageId>`, `limit=1`, and `includeAttachments=true`; then use the target attachment's `localPath`.
