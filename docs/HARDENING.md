# Hardening Pass — 2026-08-31

A dedicated audit-and-cleanup pass: not feature work. Four parallel audits covered
architecture, the Card element's full footprint, interaction-performance-critical
code paths, and security/privacy/dependencies, followed by the Card removal itself,
a couple of small concrete fixes, and one user-reported bug found along the way.

**Headline finding: this codebase was already unusually well-hardened.** Every
security/privacy/dependency check came back clean, and the performance audit found
a codebase with pervasive, deliberate optimization discipline (narrow Zustand
selectors, structural-sharing undo/redo, identity-preserving projection). Most of
this document is therefore "already fine" — that's a real, valid outcome of an
audit, not a failure to find things to change.

## Severity key

- **CRITICAL** — security vulnerability, data-loss risk, severe corruption, major reliability issue.
- **HIGH** — a real bug, memory leak, significant performance issue, or likely user-facing failure.
- **MEDIUM** — a meaningful maintainability, performance, or reliability improvement.
- **LOW** — minor cleanup, a theoretical edge case, or cosmetic technical debt.

No CRITICAL findings.

---

## HIGH

### H1 — Seven pre-existing e2e test failures (connector selection + flow panel + Queue labeling) — FIXED

- **Affected area:** `e2e/critical-journey.spec.ts` (2 tests), `e2e/flow.spec.ts` (5 tests).
- **Evidence:** `npx playwright test` failed these 7 tests. Confirmed via `git stash`
  that all 7 failed identically on the clean, pre-audit tree — not caused by this
  session's Card removal. Initially deferred to a follow-up task as out of scope;
  investigated and fixed directly once the user asked for it explicitly. Three
  independent, unrelated root causes were compounding:
  1. **A test tried to rename a Queue node** (`labelNode(page, 3, 'orders.v1')` in
     `buildArchitecture`), but a Queue's name is always just its kind — there is no
     text field to type into (`DraftNodeView.tsx`'s `beginEditing` explicitly
     excludes `type === 'queue'`). The double-click never opened an editor because
     there was never going to be one; every test sharing that helper failed.
  2. **The tests targeted a UI that had been redesigned.** `page.getByTitle('Flows')`
     used to open the full Flow management drawer (`.dc-flow-item`/
     `.dc-flow-title-input`); it now opens a different, lighter "Switch flows (F)"
     dropdown (per the CHANGELOG's "compact flow switcher" entry) — reaching the
     drawer now requires that dropdown's "Manage flows…" action. Loose substring
     matching in `getByTitle('Flows')` (which also matches "Switch flows (F)")
     masked the mismatch by clicking *something*, just the wrong element, so the
     drawer's contents were never found. A genuine product bug turned up in the
     same area while fixing this: selecting a *different* connector while a
     sub-panel (e.g. flow membership) was open never closed that sub-panel — it
     kept showing the previous connector's data, because the popover's `open`
     state never actually toggles false during an edge-to-edge reselection. Fixed
     in `EdgeInspectorPopover.tsx` with an effect keyed on the selected edge's id.
  3. **The remaining flakiness was a test-helper precision bug, not a product bug.**
     `clickEdgeBetween` clicked the *naive average of two node centers* rather than
     the connector's own rendered path. That's fine when both nodes share a height,
     but a Queue's default height (48px) differs enough from a Service's (68px)
     that the averaged point could miss the actual (curved/stepped) path entirely
     — meaning nothing got selected, so every element the test looked for next
     legitimately never existed. Rewritten to click the real path's geometric
     midpoint via `SVGPathElement.getPointAtLength()`, which is exact regardless of
     node size or routing shape.
- **User impact:** none of the three were product bugs affecting real usage, except
  the confirmed `EdgeInspectorPopover` sub-panel staleness (§2) — a real, if narrow,
  UX bug (switching connectors while a panel like flow-membership is open leaves
  it showing stale data) — now fixed.
- **Resolution:** all three root causes fixed directly (test helpers rewritten,
  `EdgeInspectorPopover.tsx` patched). All 71 e2e tests pass; the full suite runs
  in ~1.2 minutes (previously 5+ minutes of timeouts/retries before the tests were
  even fixed to fail fast).
- **Tests added:** the fixes *are* the test suite — no separate regression coverage
  needed beyond restoring these 7 tests to green.

---

## MEDIUM

### M1 — Queue nodes showed as "Untitled" in Presentation Mode / the Flow panel — FIXED

- **Affected area:** `src/ui/Editor/FlowBar.tsx`, `src/ui/Editor/FlowPanel.tsx`.
- **Evidence:** user-reported with a screenshot mid-session. A Queue node has no
  editable text field at all (`DraftNodeView.tsx`'s double-click-to-edit gate
  explicitly excludes `type === 'queue'` — "a queue's name is always just its
  kind"), so `node.text` is *always* empty for a Queue. `FlowBar.tsx`/
  `FlowPanel.tsx` displayed a flow step's source/target node via
  `node.text || 'Untitled'`, which is wrong for any type whose identity
  legitimately comes from its kind rather than free text.
- **User impact:** every Presentation Mode step and Flow-panel entry involving a
  Queue (or Topic/Stream) showed "Untitled" instead of "Queue"/"Topic"/"Stream" —
  100% reproducible, not an edge case.
- **Resolution:** added `displayNameFor()` (`src/document/factory.ts`) — falls back
  through `node.text` → a per-type/sub-kind display name (reusing the same
  kind vocabulary as the on-canvas caption in `nodes/describe.ts`, in Title Case
  rather than the SVG caption's all-caps) → `'Untitled'` only as the last resort
  for a genuinely unrecognized type. Wired into all 7 `'Untitled'` call sites
  across `FlowBar.tsx`/`FlowPanel.tsx`.
- **Tests added:** `displayNameFor` describe block in `tests/document.test.ts` (5
  tests) — own text wins, Queue/Topic/Stream fallback, Service/Database sub-kind
  fallback, generic per-type fallback for every other blank-text type,
  whitespace-only text treated as blank.

### M1.5 — A request/response connector's reply line was effectively invisible — FIXED

- **Affected area:** `src/styles/canvas.css` (`.dc-edge-response-line`,
  `.dc-edge-response-label`).
- **Evidence:** user-reported live, with a screenshot. Measured directly via the
  DOM: the reply line's default (non-hover/non-selected) opacity was `0.28`; at
  that opacity a typical stroke color blended against the light theme's
  near-white canvas background to within a few RGB steps of the background
  itself (`rgb(198,225,222)` on `rgb(251,251,252)`, measured) — below any usable
  contrast threshold. The component's own doc comment states the opposite intent
  ("a low, but never fully invisible, opacity — a diagram screenshotted
  mid-conversation shouldn't look incomplete"), so this was the implementation
  failing its own stated goal, not a deliberate design choice.
- **User impact:** every connector with a `response` set (a request/reply pair)
  showed its "200"-style response chip with no visible line connecting it back
  to the request — the chip looked like a floating, disconnected label.
- **Resolution:** raised the default opacity to `0.5` for both the line and its
  label (label was `0.4`, raised to match) — clearly softer than the `0.85`
  revealed (hover/selected) state, but perceptible against either theme.
  Verified visually in-browser before and after, at multiple zoom levels.

### M1.6 — The reply line sat too close to the request line/label once visible — FIXED

- **Affected area:** `src/edges/routing.ts` (`RESPONSE_LANE_DELTA`).
- **Evidence:** user-reported live, immediately after M1.5 landed and the reply
  line actually became visible for the first time — at the previous separation
  (`RESPONSE_LANE_DELTA = 0.35`, a ~3.5px line offset and ~7px label offset) the
  two lines read as a doubled/smudged stroke and the "200" chip visually
  overlapped the primary line and its own label.
- **User impact:** cosmetic but real — the two lines/labels weren't legible as
  two distinct things.
- **Resolution:** increased `RESPONSE_LANE_DELTA` to `1.25` (~12.5px line
  separation, ~25px label separation) — enough clearance to read cleanly, while
  remaining a non-half-integer offset so it still can't land exactly on a real
  parallel sibling connector's own lane (the invariant the original 0.35 was
  chosen to satisfy, just with more room to spare). Verified visually.
- **Tests added:** none beyond the existing `RESPONSE_LANE_DELTA`-relative
  geometry tests in `tests/routing.test.ts`/`tests/rendering.test.ts`, which
  assert relative properties (routes differ, labels don't land on the same
  point) rather than the exact constant, so they remain valid unchanged.

### M2 — `findDropNode` copied + sorted every node on every reconnect-drag frame — FIXED

- **Affected area:** `src/canvas/DraftEdgeView.tsx` (`EdgeEndpointHandle`).
- **Evidence:** ran on every pointer-move frame while dragging a connector
  endpoint: `[...nodes].filter(...).sort((a,b) => b.z - a.z).find(...)` — an array
  copy plus an O(n log n) sort per frame, purely to find the highest-z node under
  the cursor.
- **User impact:** negligible at the app's tested/realistic scale (100 nodes);
  would compound at the app's own documented 5,000-node import ceiling.
- **Resolution:** replaced with a single-pass max-z scan — same result, no copy,
  no sort, O(n) instead of O(n log n) with allocation.
- **Tests added:** none — behavior-neutral refactor, already covered by existing
  reconnect e2e tests (`e2e/editing.spec.ts`'s `reconnection` suite), all still
  passing.

### M3 — `EdgeEndpointHandle`'s drag-scoped `keydown` listener could leak on unmount — FIXED

- **Affected area:** `src/canvas/DraftEdgeView.tsx`.
- **Evidence:** the listener added in `onPointerDown` was only removed by the
  gesture's own `endDrag()` (called from `onPointerUp` or its own Escape
  handler) — never from a `useEffect` unmount cleanup. If the component
  unmounted mid-drag (e.g. the edge is deleted by another action while the user
  is still holding the pointer down on its endpoint handle), the listener would
  never be removed.
- **User impact:** narrow — requires an edge to be deleted/deselected mid-gesture
  — but a real, if rare, leak on a long-running session.
- **Resolution:** added a `useEffect` cleanup on mount, alongside the existing
  gesture-end cleanup, so both paths are covered.
- **Tests added:** none — a DOM-listener lifecycle edge case not practically
  unit-testable in this codebase's existing test infrastructure; documented here
  instead per "document uncertain cases instead of introducing speculative
  behavior."

### M4 — `evaluateAttachCandidates` / drag hit-testing is unindexed — documented only

- **Affected area:** `src/canvas/dragTargets.ts`.
- **Evidence:** an O(n) scan over every node, run on every pointer-move frame
  during a single-node drag, with no spatial index (grid/quadtree).
- **User impact:** none observed — the app's own performance test suite
  (`tests/performance.test.ts`) validates at 100 nodes/180 edges and stays fast;
  this scan is untested at the documented 5,000-node import ceiling, a 50×
  gap, but there's no evidence drag-to-attach is actually slow there.
- **Resolution:** **not implemented.** A spatial index is real engineering effort
  with its own complexity/risk, and Draft Canvas's stated purpose (quickly
  explaining systems in a meeting) makes a 5,000-node canvas an unlikely real
  workload. Recommended only if evidence of real-world slowness appears.

### M5 — Autosave re-serializes and re-encrypts the *entire* document on every write — documented only

- **Affected area:** `src/storage/IndexedDbRepository.ts`, `src/crypto/documentCipher.ts`.
- **Evidence:** every debounced autosave does a full `JSON.stringify(document)`
  followed by AES-256-GCM encryption of the whole payload — not a delta —
  regardless of how small the actual edit was.
- **User impact:** none observed at typical document sizes. The 700ms
  debounce/4s max-wait pairing keeps this off the interaction-critical path
  (writes are async), but a document with many large code blocks (up to the
  200,000-char-per-block limit) would see real per-save cost.
- **Resolution:** **not implemented.** Incremental/delta persistence is a genuine
  architectural change with its own risk (partial-write safety, delta-vs-snapshot
  correctness) — not justified without evidence of a real problem, and explicitly
  the kind of thing this pass's brief says not to build speculatively.

### M6 — Document titles and background images are stored unencrypted — documented only

- **Affected area:** `src/storage/IndexedDbRepository.ts`, `src/document/types.ts` (`DraftSummary`).
- **Evidence:** document *bodies* are AES-256-GCM encrypted at rest; the
  `documents` summary store (id/title/timestamps/counts, used for the library
  list) and the `backgroundImages` store are not. This is intentional and
  documented in-code (a title needs to be readable without a full decrypt to
  render the library list quickly; a background image is treated as less
  sensitive than diagram content).
- **User impact:** a document **title** is free user text and could carry
  sensitive information the user assumes is covered by "my diagrams are
  encrypted."
- **Resolution:** **not changed** — this is a threat-model/product decision, not
  a bug. Flagged here so it's a conscious choice rather than an unexamined gap;
  worth confirming with whoever owns the privacy story that "encrypted" should
  be understood as "diagram content encrypted, metadata not."

---

## LOW

### L1 — Stale doc-comment referencing a test file that doesn't exist — FIXED

- **Affected area:** `src/canvas/SvgSurface.tsx`.
- **Evidence:** a comment pointed at `tests/svg-escaping.test.ts`; the actual
  coverage lives in the "XML escaping" block of `tests/rendering.test.ts`.
- **Resolution:** comment corrected to point at the real location.

### L2 — `DraftEdgeView.tsx` (54KB) and `Canvas.tsx` (40KB) are outsized vs. the rest of the codebase — documented only

- **Evidence:** every other file in the codebase is well under 30KB; these two
  are 2-3× that, concentrating drag/resize/reconnect/attachment-reveal/
  response-phase-animation logic (`DraftEdgeView.tsx`) and pan/zoom/selection/
  drag-to-attach/quick-connect wiring (`Canvas.tsx`).
- **Resolution:** **not implemented.** Splitting a battle-tested, heavily
  interaction-dependent component carries real regression risk disproportionate
  to a hardening pass's risk budget. Recommended as a future decomposition
  candidate, not undertaken here.

### L3 — All edges re-render and rebuild their obstacle list on any committed node move — documented, no action

- **Affected area:** `src/canvas/DraftEdgeView.tsx`, `src/edges/routing.ts`.
- **Evidence:** obstacle-avoidance needs every other node's committed geometry, so
  `DraftEdgeView` subscribes to the full node list rather than just its own
  endpoints — a self-acknowledged, in-code-documented tradeoff. Already
  mitigated during live drags via `interactionActive` (obstacles skipped
  entirely mid-gesture, computed once on commit).
- **Resolution:** left as-is — a deliberate, already-mitigated design decision,
  fine at the app's tested scale.

---

## Removed / Simplified

### Card and `rounded` node types removed entirely

Card and the already-dead `rounded` node type were field-identical (same schema,
same generic `box()` renderer, differing only in corner radius) — exactly the
"vaguely differentiated primitive" the product brief asked to consolidate away.
Per an explicit product decision made during this session: **no blank-box
primitive survives.**

**Schema:** `CURRENT_VERSION` bumped 6→7. A new migration,
`migrateCardAndRoundedToNote` (`src/document/migrate.ts`), retypes any persisted
`card`/`rounded` node — and any `card`/`rounded` attachment folded into a node or
edge — to `note`, the closest surviving "just hold some text" primitive. Every
other field (text, position, size, accent) is left untouched, so a migrated
document keeps showing the same content in the same place, just under a
different type. `card`/`rounded` were removed from `NODE_TYPES`/`DraftNodeType`
and `ATTACHABLE_TYPES` entirely (not kept for backward-compat reading — the
migration handles that).

**Import-validator fallback:** `document/validate.ts`'s fallback for an
unrecognized node type changed from `'card'` to `'note'`, matching the migration
target.

**Creation surface:** the `CARD_PRESET` toolbar entry, its `R` keyboard shortcut
(freed, not reassigned), and its Quick Connect menu entry are gone.
Double-click-on-empty-canvas with no tool armed — previously an instant Card —
now opens the same type-picker menu (`QuickConnectMenu`) already used when a
connector is dropped on empty space, so the user explicitly picks Note/Text/
Code/Service/etc. rather than an implicit type standing in for the removed
blank box.

**Rendering/attachments:** `nodes/describe.ts`'s dedicated `card`/`rounded`
switch cases were removed (the `default:` branch — now unreachable via any
validated document, kept as a defensive fallback for a type that somehow
bypassed validation — still calls the same `box()` primitive).
`AttachmentPopover`'s type-label map dropped its `card`/`rounded` entries.

**Tests:** `card`/`rounded` were used pervasively across ~15 unit test files and
6 e2e specs purely as a generic node-type fixture — all retyped to `note` (or
another type where the test specifically cared about type-distinct behavior).
Four new regression tests cover the v6→v7 migration itself (node retyping,
node-attachment retyping, edge-attachment retyping, every other type left
untouched). One e2e test ("double-clicking empty canvas starts a card
immediately") was rewritten to assert the new type-picker behavior instead.

**Docs:** `docs/SCHEMA.md` (type table, fallback description, a new v6→v7
worked-example paragraph), `docs/ROADMAP.md` (1.1's description), `README.md`
(shortcuts table, drawing description), and `CHANGELOG.md` (new Unreleased
entries under Changed/Removed) all updated. Historical CHANGELOG entries that
already mention Card (the 0.1.0-alpha.1 release notes) were left untouched —
they're a record of the past, not current documentation.

---

## Things Reviewed That Were Already Fine

Per the brief: if something is already performant, secure, simple, or
well-designed, the right move is to leave it alone and say so, not manufacture
work. All of the following were reviewed in depth and found to need no change.

**Security / privacy:**
- **XSS/SVG injection** — a single, consistently-used escaping funnel
  (`render/svg/element.ts`'s `serialize()`/`escapeXmlText`/`escapeXmlAttr`,
  plus control-character stripping) sits between every piece of user text and
  the only two `dangerouslySetInnerHTML` call sites in the app. Verified by
  tests injecting `<script>` payloads into labels, code, and connector text.
- **Encryption** — AES-256-GCM, a fresh `crypto.getRandomValues` IV on every
  single encryption call (never reused), a non-extractable master key, 600k-
  iteration PBKDF2 for passphrase export with a fresh salt, and
  decrypt-to-verify before ever overwriting a readable record during storage
  migration. No plaintext document content found in any log statement.
- **Zero network activity** — not just an absence of `fetch`/XHR code, but a
  production Content-Security-Policy (`connect-src 'none'`) that makes "no
  network calls" a browser-enforced guarantee rather than a hope. Confirmed no
  analytics/telemetry dependency exists.
- **Import validation** — `document/validate.ts` is a thorough "repair, don't
  reject" funnel: every enum field is checked against a closed allowlist, every
  numeric field is finite-and-clamped, every collection is size-capped, IDs are
  deduplicated and cycle-checked. A malformed or hostile import is far more
  likely to be silently repaired (with a reported diff) than to crash the app.
- **Randomness** — every ID and every piece of cryptographic material uses
  `crypto.getRandomValues`; the only non-cryptographic PRNG in the codebase is
  explicitly, deliberately scoped to non-security "hand-drawn" visual jitter
  (`render/roughness/seed.ts`), and is documented as such.
- **Dependencies** — six runtime dependencies, every one in active,
  single-purpose use (canvas engine, syntax highlighter with curated language
  subset, GIF encoder, IndexedDB wrapper, state store, view framework). No
  unused, duplicated, or oversized-for-its-role package found.

**Performance / architecture:**
- **React re-render discipline** — pervasive, deliberate: Zustand selectors
  return primitives (booleans, strings) instead of objects specifically to
  avoid unnecessary re-renders, node/edge lookup goes through a `WeakMap`-cached
  index rather than a scan, and the projection layer preserves object identity
  for unchanged nodes/edges so editing one node's text touches exactly one
  component.
- **Undo/redo** — structural-sharing snapshots keep a typical entry cheap
  (kilobytes, not a full-document copy), drag/resize gestures coalesce into one
  history entry, rapid same-field edits coalesce via a time-windowed key, and
  history is bounded at 150 entries.
- **Autosave debounce/coalescing** — triggered off a revision counter (never a
  raw re-render), 700ms debounce with a 4s hard cap on continuous editing,
  never overlaps in-flight writes, flushes on tab-hide via `visibilitychange`
  (deliberately not `beforeunload`, to preserve bfcache).
- **Syntax highlighting** — synchronous by design (an async highlighter would
  flash unstyled code on every pan) but LRU-cached, decoupled from keystrokes
  via an uncontrolled textarea with commit-on-blur, and capped at 2000 lines
  for pathological input.
- **Marquee selection** — fully delegated to React Flow's own implementation;
  no custom hit-testing risk in that path.
- **Memory/listener hygiene** — every `addEventListener` in the codebase but
  one (fixed above, M3) was already correctly paired with cleanup; every
  `URL.createObjectURL` in the always-mounted canvas-background path was
  already correctly revoked.
- **Migration discipline** — a single funnel (`migrateToCurrent`), one
  documented invariant ("nothing else may branch on `version`"), a worked
  example in `docs/SCHEMA.md` for every prior version bump.
- **Overall architecture** — clean separation between the pure domain model
  (`document/`, deliberately free of React/canvas-library imports), the canvas
  rendering layer, the Zustand store (a thin orchestration layer, not a
  monolith — nearly every mutating action delegates to pure functions in
  `document/operations.ts`), and the SVG/PNG/GIF export pipeline (which
  reuses the same node/edge "describe" functions the live canvas uses, so
  export can't visually drift from what's on screen).

---

## Deliberately left unchanged

- Bundle composition and startup — already well-chunked (`xyflow`, `refractor`
  each split into their own chunk via Vite's `manualChunks`), no unnecessary
  eager imports found. No action needed.
- The connector visual duplication between `DraftEdgeView.tsx` (live/
  interactive) and `edges/describe.ts` (headless export) — a self-documented,
  deliberate architectural tradeoff (per in-code comments and
  `docs/ARCHITECTURE.md`), not a leftover. Left as-is; flagged in the original
  architecture audit as worth watching for drift, not worth restructuring here.
- `docs/SCHEMA.md`'s sample document still shows `"version": 4` and worked
  examples only through v2→v3 — pre-existing documentation drift unrelated to
  this session's changes (a v6→v7 worked example was added; backfilling v3→v4
  through v5→v6 examples was judged out of scope for this pass).
