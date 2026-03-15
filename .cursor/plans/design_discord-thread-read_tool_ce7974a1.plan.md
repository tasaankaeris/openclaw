---
name: Design discord-thread-read tool
overview: Add a low-token Discord thread reader to discord-thread-tools with default latest-window reads, opaque cursor continuation, and minimal normalized output.
todos:
  - id: add-tool-schema
    content: Add `discord-thread-read` tool definition and register it in `extensions/discord-thread-tools/index.ts`.
    status: pending
  - id: implement-discord-native-read
    content: Implement Discord-native read path using `GET /channels/{threadId}/messages` with stateless cursor mapping to `before`/`after` and optional `around` jump.
    status: pending
  - id: shape-output
    content: Return minimal message summaries plus opaque continuation cursor and compact dedupe guidance.
    status: pending
  - id: extract-shared-helper
    content: Refactor read/pagination/formatting logic into reusable helper(s) for future `discord-channel-read` support.
    status: pending
  - id: add-design-headers
    content: Add detailed source-file header comments capturing API semantics, cursor model, explicit-vs-implicit intent boundary, and attachment metadata behavior so design rationale is preserved in code.
    status: pending
  - id: tests-and-validation
    content: Add/update tests for cursor semantics, continuation metadata, dedupe overlap behavior, and run lint/test checks.
    status: pending
isProject: false
---

# Add `discord-thread-read` to Discord Thread Tools

## Goal

Implement a Discord thread reader in the existing extension (`discord-thread-tools`) optimized for minimal token spend and straightforward LLM use.

## Explicit vs Implicit Requirements

- **Explicit tool responsibilities (must do):**
  - Read thread windows deterministically and return factual message data.
  - Return neutral navigation actions (`readEarlierRequest`, `readLaterRequest`, `aroundMessageTemplate`).
  - Surface attachment presence and ids when present, without forcing an attachment-hunting workflow.
- **Implicit caller intent (must not be assumed by tool):**
  - The tool must not inject objective-specific guidance such as "keep searching for attachments" unless explicitly requested by the caller.
  - If the caller's objective is unclear, that clarification is the agent's responsibility (ask user), not the read tool's responsibility.

## Placement and Scope

- Extend `[extensions/discord-thread-tools/index.ts](extensions/discord-thread-tools/index.ts)` with a new tool: `discord-thread-read`.
- Reuse thread validation and HTTP helpers in `[extensions/discord-thread-tools/src/discord-thread-helpers.ts](extensions/discord-thread-tools/src/discord-thread-helpers.ts)`.
- Keep this thread-scoped only for now (`threadId` required). Do not add `discord-channel-read` yet; design helper logic so channel-read can be added later with minimal duplication.

## Source Documentation Requirement

- Add/expand top-of-file header comments in the implementation files so this chat context is preserved in code even if the plan is discarded.
- Required files for header documentation:
  - `[extensions/discord-thread-tools/index.ts](extensions/discord-thread-tools/index.ts)`
  - `[extensions/discord-thread-tools/src/discord-thread-helpers.ts](extensions/discord-thread-tools/src/discord-thread-helpers.ts)`
- Header content must explicitly capture:
  - Why the tool is objective-neutral (explicit vs implicit requirements boundary).
  - Why navigation terminology is `earlier`/`later` and how cursors map to Discord `before`/`after`.
  - Anchor-relative live-thread behavior (new incoming messages may appear on `later` reads by design).
  - What `nextActions` guarantees (full executable requests with explicit effective optional values).
  - Attachment semantics: metadata + CDN/proxy URLs only, no inline binaries.
  - Why attachment handling is metadata/capability-based, not injected objective-specific follow-up actions.
  - Filtering behavior (`includeSystem`) vs raw-window anchors and counts (`rawCount`, `filteredOutCount`, `filtered`).
  - Around-read behavior and how to obtain attachment details with `aroundMessageId` + `includeAttachments=true`.

## Proposed Tool Contract

- **Tool name:** `discord-thread-read`
- **Required inputs:**
  - `accountId: string`
  - `threadId: string`
- **Optional inputs:**
  - `limit: integer` (default `30`, min `1`, max `100`)
  - `cursor: string` (opaque token from a previous `discord-thread-read` result)
  - `direction: "earlier" | "later"` (optional, default from cursor; ignored when no cursor)
  - `aroundMessageId: string` (optional jump to a message-centered window)
  - `includeContent: boolean` (default `true`)
  - `contentMaxChars: integer` (default `400`, min `0`, max `4000`)
  - `includeSystem: boolean` (default `false`)
  - `includeEmbeds: boolean` (default `false`)
  - `includeAttachments: boolean` (default `false`)
- **Discord-native semantics:**
  - Internal implementation uses Discord cursors (`before`/`after`) but does not expose raw cursor fields in primary caller contract.
  - If no cursor is provided, returns latest `limit` messages (LLM-friendly default for “read this thread”).
  - If `cursor` is provided, read the next window based on cursor direction (`earlier` by default) and optional `direction` override.
  - If `aroundMessageId` is provided, ignore cursor and return an around-window centered on that message.
  - Returned actions are navigation primitives, not objective-specific instructions.
- **Account handling:**
  - Match existing `discord-thread-tools` pattern: `accountId` remains required.
  - Do not add account auto-resolution behavior in this tool.

## Retrieval Strategy

- Perform one Discord read request to `GET /channels/{threadId}/messages` per call, plus thread validation fetch when enforcing allowlist constraints.
- For initial reads: latest `limit`.
- For continuation reads: decode opaque `cursor`, validate `threadId`, map to `before`/`after` using cursor anchors.
- For around-jump reads: use Discord `around=<aroundMessageId>` with `limit`.
- Keep continuation token compact (base64url JSON; no HMAC) with fields:
  - `v` (version)
  - `threadId`
  - `dir` (`earlier` or `later`)
  - `anchorFirstMessageId`
  - `anchorLastMessageId`
  - `limit`
  - optional `snapshotNewestMessageId`
  - optional `issuedAt`
- Deterministic cursor algorithm:
  - Normalize fetched message order to `oldest_to_newest` before output and before deriving anchors.
  - Derive cursor anchors from the raw fetched window (before any `includeSystem` filtering) to avoid pagination gaps.
  - For `earlier` navigation, query with `before=<currentOldestId>` and produce `earlierCursor` anchored to the new window's edges.
  - For `later` navigation, query with `after=<currentNewestId>` and produce `laterCursor` anchored to the new window's edges.
  - If `direction` override is provided with `cursor`, the emitted cursor `dir` reflects the effective override direction.
  - Emitted `readEarlierRequest`/`readLaterRequest` always include explicit effective values for all optional fields (`limit`, `includeContent`, `contentMaxChars`, `includeEmbeds`, `includeAttachments`, `includeSystem`).
  - When `cursor` is present and caller also passes `limit`, use the caller `limit` and store that limit in the next emitted cursors.
  - When a continuation query returns zero messages, return empty `messages`, `returnedCount=0`, and omit further cursor in that direction.
  - Replay scope is anchor-relative for a live thread: new incoming messages may appear on `later` reads by design.
- Around-mode semantics:
  - `aroundMessageId` mode ignores `cursor` and `direction`.
  - Return a centered window (best effort) in normalized `oldest_to_newest` order.
  - Emit both `earlierCursor` and `laterCursor` when window edges allow continuation.

## Output Shape

Return a structured `jsonResult` payload:

- `ok: true`
- `threadId`
- `messages: Array<{ id, authorId, authorName, content?, createdAt, isSystem, hasAttachments, attachmentCount, hasEmbeds, embedCount, attachments?, embeds? }>`
- `returnedCount: number` (always `messages.length`, after filtering)
- `rawCount: number` (number of fetched messages before output filtering)
- `filteredOutCount: number` (number filtered out from this window before output)
- `filtered?: { systemMessagesOmitted: number }` (present when `includeSystem=false`)
- `earlierCursor?: string` (opaque token for earlier messages)
- `laterCursor?: string` (opaque token for later messages when derivable)
- `dedupeKey: "id"`
- `window: { oldestId, newestId, boundaryExcludesAnchor: true }` (boundaries are derived from raw fetched window, not filtered output)
- `progress: { canReadEarlier: boolean, canReadLater: boolean }` (derived from raw-window anchor availability)
- `attachmentMessageIds?: string[]` (ordered newest-to-oldest attachment-bearing message ids from the raw window)
- `capabilities: { attachmentDetail: "Attachment details are available by calling discord-thread-read with a concrete aroundMessageId and includeAttachments=true." }`
- `nextActions?:`
  - `readEarlierRequest?: { accountId, threadId, cursor, direction: "earlier", limit, includeContent, contentMaxChars, includeEmbeds, includeAttachments, includeSystem }` where `readEarlierRequest.cursor` equals `earlierCursor`
  - `readLaterRequest?: { accountId, threadId, cursor, direction: "later", limit, includeContent, contentMaxChars, includeEmbeds, includeAttachments, includeSystem }` where `readLaterRequest.cursor` equals `laterCursor`
  - `aroundMessageTemplate: { accountId, threadId, aroundMessageId: string, limit, includeAttachments, includeEmbeds, includeContent, contentMaxChars, includeSystem }` (caller provides the concrete message id)
- Include-flag projection rules:
  - If `includeContent=false`, omit `content`. If `includeContent=true`, clamp content to `contentMaxChars` and append a truncation marker when trimmed.
  - Always include `hasAttachments`, `attachmentCount`, `hasEmbeds`, `embedCount`, and `isSystem`.
  - If `includeAttachments=true`, include minimal `attachments` entries: `{ id, filename, contentType, size, url, proxyUrl }`.
  - Attachment entries are metadata + Discord CDN/proxy URLs only (no inline binary/base64 payloads).
  - If `includeEmbeds=true`, include minimal `embeds` entries: `{ type, title, description, url }`.
  - If `includeSystem=false`, omit system messages from `messages` and include `filtered: { systemMessagesOmitted }`.
  - If a fetched window contains only filtered-out messages, return `messages: []` with non-zero `rawCount`/`filteredOutCount` and keep continuation cursors so pagination can continue safely.
  - Never emit objective-specific attachment follow-up actions by default.
  - If attachments are present and `includeAttachments=false`, include `attachmentMessageIds` as neutral metadata only.
  - Include a neutral capability note describing how to fetch attachment details (`aroundMessageId` + `includeAttachments=true`) without suggesting that caller should do so now.
  - When `earlierCursor` exists, emit `readEarlierRequest` as a full executable low-token call object (includes `accountId` and `threadId`).
  - When `laterCursor` exists, emit `readLaterRequest` as a full executable low-token call object (includes `accountId` and `threadId`).

Error behavior:

- Success responses always include `ok: true`.
- Validation/auth/Discord/network failures are thrown as tool errors (no `{ ok: false }` success payload).

## Validation and Guardrails

- Reuse `assertThreadBelongsToAllowedParent` to keep existing guild/parent allowlist behavior.
- Validate `limit` bounds and cursor integrity/thread match when `cursor` is provided.
- Validate `direction` only when `cursor` is present.
- Validate `aroundMessageId` as a Discord snowflake-shaped id when provided.
- Validate `contentMaxChars` bounds and ignore `contentMaxChars` when `includeContent=false`.
- Validate that schema uses enum-style fields only (no union schema constructs) to match repo tool-schema guardrails.
- Keep tool limited to Discord sessions using existing `ensureDiscordContext` pattern.
- Document that callers should treat `message.id` as stable primary key and merge idempotently across calls.

## Extensibility for Future `discord-channel-read`

- Extract shared read/pagination/formatting helper(s) in `[extensions/discord-thread-tools/src/discord-thread-helpers.ts](extensions/discord-thread-tools/src/discord-thread-helpers.ts)`, parameterized by `channelId` + optional thread validation toggle.
- This allows a future `discord-channel-read` tool to reuse the same Discord-native cursor logic without changing the current thread API.

## Verification Plan

- Add/adjust tests in `extensions/discord-thread-tools` for:
  - default latest-30 behavior (no cursor provided)
  - cursor encode/decode integrity and versioning
  - threadId mismatch/invalid cursor rejection
  - bidirectional navigation (`earlierCursor` and `laterCursor`) and `direction` overrides
  - around-jump behavior via `aroundMessageId`
  - deterministic ordering and anchor derivation (`oldest_to_newest`)
  - anchor derivation from raw (pre-filter) windows with `includeSystem=false` (no skipped messages)
  - filtered-only windows (`rawCount>0`, `returnedCount=0`) continue to advance via valid cursors
  - continuation zero-results behavior (no further cursor in exhausted direction)
  - validation failures
  - continuation correctness via `earlierCursor`/`laterCursor` and boundary exclusion semantics
  - repeat-safe behavior under simulated concurrent new messages (duplicate IDs allowed across windows; dedupe by ID)
  - include flags shaping (`includeSystem`, `includeEmbeds`, `includeAttachments`) with minimal output projection
  - attachment payload shape uses metadata + CDN/proxy URLs (no inline blobs)
  - content controls (`includeContent`, `contentMaxChars`) for low-token scans
  - `nextActions` generation for neutral navigation primitives only (`readEarlierRequest`, `readLaterRequest`, `aroundMessageTemplate`)
  - capability note + metadata-only attachment discovery path (`attachmentMessageIds` without injected follow-up actions)
  - error-path behavior (throws on invalid params, auth failures, Discord API failures)
- Run targeted checks after implementation:
  - extension tests
  - lint diagnostics for edited files
