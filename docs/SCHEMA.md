# Document schema and versioning

This document exists so the migration contract can be audited rather than trusted blindly — it
describes what `CURRENT_VERSION` actually promises, how a file moves between versions, and how
untrusted input is treated on the way in. The source of truth is always the code cited below; if
this drifts from it, trust the code.

## The version field

Every `.draftcanvas` file (and everything in IndexedDB's `bodies` store) carries a `version:
number` and a `format: "draft-canvas"` marker. `CURRENT_VERSION` is declared in
`src/document/types.ts`, currently **10**. A file missing the marker, or whose `version` isn't a
finite integer, is treated as version 1 — the oldest shape the app has ever written.

## The migration funnel

`src/document/migrate.ts` is documented in its own header as **the single funnel for
document-version handling** — nothing else in the codebase may branch on `version`. It holds one
`Migration` function per version transition, each taking a v(n)-shaped object and returning a
v(n+1)-shaped one:

| Transition | Function | What changed |
| --- | --- | --- |
| v1 → v2 | `migrateSequenceToFlows` | A single document-wide numbered walkthrough (`edge.sequence`) becomes one named Flow — order moves into `flow.steps`, edges lose `sequence`. |
| v2 → v3 | `migrateAnchors` | Connector anchor sides/offsets, previously re-derived live on every load, are computed once and persisted. A dangling edge is left for `validate.ts` to drop, as always. |
| v3 → v4 | `migrateFlowAccent` | Structural no-op — v3 has no per-flow accent to backfill. Exists only so every version has an entry. |
| v4 → v5 | `migrateBackground` | Structural no-op — v4 has no canvas-background concept; `normalizeDocument` fills in a clean, disabled default. |
| v5 → v6 | `migrateResponse` | Structural no-op — v5 has no request/response connector concept. |
| v6 → v7 | `migrateCardAndRoundedToNote` | Retypes any `card`/`rounded` node or attachment to `note` (the generic free-text type), leaving text/position/size/accent untouched. |
| v7 → v8 | `migrateHasResponse` | Introduces `hasResponse: true` for any edge that already had `response` text, so its reply line keeps rendering exactly as before. |
| v8 → v9 | `migrateAddProjectId` | Structural no-op — absent `metadata.projectId` already means Unorganized. |
| v9 → v10 | `migrateAddRouteMode` | Structural no-op — absent `routeMode` already means Smart Routing. Exists so a v9 file can't be confused with a pre-v9 one. |

Several of these are deliberate **structural no-ops**: versions where the on-disk shape didn't
actually need to change, but an entry is still required. `migrateToCurrent` walks the chain from a
file's own version up to `CURRENT_VERSION`, and a **missing** entry for any step throws
(`Missing migration from document format v${v} to v${v + 1}.`) — a gap in the chain is a hard
failure at load time, never a silent skip. This is also why bumping `CURRENT_VERSION` always means
adding exactly one new entry, even one that does nothing yet, rather than leaving room for later.

A file whose `version` is **greater than** `CURRENT_VERSION` — saved by a newer build than the one
currently reading it — is rejected outright via `UnsupportedVersionError`, which names both
versions in its message. Older builds never guess at a shape they've never seen.

## The untrusted-input boundary

`src/document/validate.ts`'s `parseDocument()` is the one place a `.draftcanvas` file (or an
IndexedDB record, or a `.dcenc` file after decryption — an encrypted export is deliberately not
treated as more trusted than a plain one) is turned into a `DraftDocument` the rest of the app can
assume is well-formed. Its policy is **repair, don't reject**, applied only after
`migrateToCurrent` has run:

- A file over `LIMITS.maxFileBytes` (24 MB), invalid JSON, or missing the `format` marker is
  rejected with a clear error — there's nothing safe to repair.
- Every other field is re-validated regardless of what the migration chain produced: enums are
  whitelisted against closed sets (node/edge kinds, accents, sides, boundary presets, node
  variants), free text is stripped of control characters and length-clamped, and numeric fields
  (`x`, `y`, `width`, `height`, `zoom`, …) are coerced to finite values via `clamp`/`finite`
  helpers — a `NaN`, `Infinity`, or wrong-typed value never reaches the live document.
- Collections over their `LIMITS` cap (`maxNodes: 5000`, `maxEdges: 10000`,
  `maxAttachmentsPerNode: 12`, `maxAttachmentsPerEdge: 4`, `maxFlows: 50`, `maxStepsPerFlow: 200`,
  `maxExtraMembersPerStep: 40`, …) are truncated, not rejected, and the truncation is reported back
  as a repair the caller can show the user.
- Dangling references (an edge whose source/target no longer exists, a `parentId` pointing at a
  boundary that isn't there, a flow step referencing a missing edge) are dropped rather than kept
  as landmines for later code to trip over.

The same `parseDocument()` funnel backs every entry point that reads a document from outside the
live session: file import, IndexedDB load, secure (`.dcenc`) import, and clipboard paste
(`src/document/clipboardCodec.ts`) — there is no second, less-careful path.

## Round-tripping

`serializeDocument`/`deserializeDocument` (`src/export/project.ts`) write and read the same JSON
shape `parseDocument` validates — export is not treated as pre-sanitized data on the way back in.
`tests/serialization.test.ts` and `tests/migrate.test.ts` are the regression suite for this
contract: the former asserts a rich document (attachments, boundaries, flows, connector details)
survives a full export/import cycle unchanged, the latter exercises every version transition,
idempotency, and the chain-completeness invariant above.
