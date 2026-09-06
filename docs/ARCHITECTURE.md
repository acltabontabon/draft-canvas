# Architecture

Draft Canvas is a single-page React application with no backend. This is the load-bearing map:
what lives where, and the handful of rules that fail silently if broken.

## Layers

```
ui/                UI and editor chrome
  ↓
canvas/            interaction: selection, dragging, snapping, connecting
  ↓
document/          the document model — pure, serializable, framework-free
  ↓
storage/           IndexedDB persistence and autosave
export/            .draftcanvas, SVG and PNG
```

Dependencies point one way. `document/` imports neither React nor React Flow, which is what lets
the file format outlive any decision made above it.

```
src/
  document/     types · factory · operations · flow · edgeSemantics · connectorSemantics · validate
                · migrate · limits
  storage/      DraftRepository · IndexedDbRepository · MemoryRepository · autosave
  history/      HistoryStack
  render/       the shared renderer (see below)
    text/       fonts · measure · layout
    code/       highlight · theme
    svg/        element · emit · markers · document
    png/        rasterize
    theme/      tokens
  nodes/        describe.ts — every node's appearance, as pure functions
  edges/        routing.ts · describe.ts · bundles.ts
  canvas/       Canvas · DraftNodeView · DraftEdgeView · projection · snapping · presets
  presentation/ useFlowPlayback
  learning/     contextual hints and the opt-in "Learn Draft Canvas" mode
  store/        editorStore · uiStore · selectors · useDocumentSession
  ui/           Library · Editor · common · theme · personality (Intentional Roughness presets)
```

## The idea that shapes everything: one renderer

The canvas and the file exporter do not draw things twice. `nodes/describe.ts` turns a node into a
**display list** (pure); `render/svg/emit.ts` turns that into an SVG element tree;
`render/svg/element.ts` serializes it. The canvas paints that string, the exporter writes it to a
file — an export is pixel-identical to the screen. Interactive chrome (handles, resize frames,
selection rings, inline editors) lives in React/CSS so it can never appear in an exported image.
Node visuals go through `dangerouslySetInnerHTML` with markup from our own escaping serializer —
`tests/code-card.test.tsx` proves a `<script>` in a label stays inert text. Text wraps in exactly
one place, `render/text/layout.ts`; nothing else may wrap.

### Edges are the one exception to "one renderer"

`edges/describe.ts` (SVG export) and `canvas/DraftEdgeView.tsx` (on-screen) are two independent
implementations of the same connector — nothing enforces that a visual addition to one is mirrored
in the other. **If you add a new visual to a connector, add it in both places.**

## Canvas boundary

The zustand store (`store/editorStore.ts`) owns the `DraftDocument`. React Flow is a controlled
view of it — `canvas/projection.ts` derives its arrays during render and preserves object identity
for unchanged nodes.

**The document is not written during a drag.** Positions stream to the rendered nodes for
smoothness; the document updates only when the gesture ends, so one drag is one undo entry.

`edges/routing.ts` is the only module that calls React Flow's path helpers, so an exported
connector traces exactly the path on screen. Two invariants worth knowing:

- **A persisted anchor (`EdgeAnchor` in `document/types.ts`) is never silently moved to a
  different side** by routing, no matter how the nodes move — only an explicit reconnect changes
  it.
- **Smart Routing's shared trunk (`edges/bundles.ts`) is derived presentation state** — never a
  node, never persisted, never in history or validation. Five bundled connectors are still five
  rows in `DraftDocument.edges`. It's stored hub-relative rather than as an absolute coordinate,
  since the document isn't written during a drag and an absolute trunk would lag the branches.

#### Relationship model

`document/connectorSemantics.ts`'s `MATRIX`, keyed by `sourceCategory>targetCategory`, is the
single source of truth every UI surface reads from: the interaction picker, the default
relation/behavior on a fresh or re-pointed connector, and the subtle warning marker for an unusual
pairing. Deliberately sparse — an undocumented pairing keeps full, unrestricted freedom; every rule
here narrows or nudges, never blocks. See [`docs/SEMANTICS.md`](SEMANTICS.md) for the actual rules.

## History

Snapshot-based, with structural sharing — every operation in `document/operations.ts` returns a
new document reusing untouched nodes. `beginInteraction`/`endInteraction` bracket a gesture into
one entry; entries sharing a `coalesceKey` merge, so typing a name is one undo. Viewport changes
persist but are never recorded.

Side effects must never run inside a React state updater — React invokes updaters twice in
development, which recorded every drag twice and made undo appear broken.

## Persistence

Two IndexedDB stores. `documents` holds summaries; `bodies` holds the documents, so the library
lists titles and timestamps without deserializing a single canvas. Autosave (`storage/autosave.ts`)
debounces at 700 ms with a 4 s ceiling and flushes on `visibilitychange`/`pagehide` — never
`beforeunload`, which disables the back/forward cache.

### The `src/crypto/` boundary

`bodies` rows are encrypted at rest with AES-256-GCM. `src/crypto/` is the only place that touches
`crypto.subtle`, and `storage/IndexedDbRepository.ts` is the only caller of it — nothing else in
the app knows a document is ever anything but plain JSON.

- `keyStore.ts` gets-or-creates a single, profile-wide, **non-extractable** `CryptoKey` in its own
  IndexedDB store (separate from `bodies`, so neither can take the other down).
- `documentCipher.ts` encrypts before every `put` and decrypts after every `get`. A GCM
  authentication failure (tampered ciphertext, wrong key) never overwrites the still-encrypted
  row — a decrypt failure must not look like an invitation to re-save over the only copy.
- `passphraseExport.ts` is a second, independent use of `crypto.subtle` for the `.dcenc` export
  format — it shares no key material with the profile's local storage key.

Failures degrade rather than destroy: IndexedDB unavailable falls back to an in-memory repository
and the UI says so plainly; a corrupt record is repaired through the same validator as an imported
file.

## Flows and presentation

A `DraftFlow` narrates connectors that already exist — it never duplicates a node or an edge, only
orders references to them (`document/flow.ts`). A step usually references one connector, but can
also spotlight extra nodes/edges or pin its own viewport (a "frame" step). This is deliberately
distinct from **Focus Mode** (`store/editorStore.ts`'s `FocusState`) — Focus is an arbitrary,
unordered highlight available any time in edit mode; a frame step is an ordered member of one
specific Flow, visible only during that Flow's playback.

Multiple Flows can share early steps and diverge later, since a step only ever references a
connector that already exists — nothing is copied. A reply is just another connector, not a
distinct concept.

## Command surface

`src/commands/registry.ts`'s `commandsFor(ctx)` is a pure function from the current
selection/mode/document to the commands that make sense right now — re-derived on every keystroke,
never registered ahead of time or kept in a store. Every command's `run` is one call into an
existing `editorStore`/`uiStore` action, so the palette introduces no second way to mutate the
document. The right-click context menu (`commands/contextMenu.ts`) is a second surface over the
identical command functions, filtered to a small per-target subset and excluding any command that
returns a `CommandStage` (a follow-up picker, e.g. "Connect to…") — it's deliberately flat, no
flyouts.

## Untrusted input

`document/validate.ts` is the only door into the document model, used for both imported files and
records read back from IndexedDB. Its policy is **repair, don't reject**: a diagram with three
broken edges opens with the other ninety-seven intact, and says what it dropped. It enforces hard
caps (see `document/limits.ts`), clamps coordinates, strips control characters, renames duplicate
ids, and detaches cyclic groups. Colour is an enum, not a string, so no user-supplied value ever
reaches an SVG `fill`.

## Schema evolution

`document/types.ts` is the source of truth for the document shape — every field on
`DraftDocument`, `DraftNode`, `DraftEdge`, and `DraftFlow` is defined there.

`document/migrate.ts` is the only place a version number is read. Adding a format version means
bumping `CURRENT_VERSION` and adding one function there, taking a version-`n` object and returning
a version-`n+1` one. An older file opens through the migration chain; a newer one is refused with a
message naming both versions, rather than being silently mangled.

## Testing

| Layer | Where |
| --- | --- |
| Document model, operations, flows | `tests/document.test.ts`, `tests/flow.test.ts` |
| Relationship model, semantic/kind inference and re-inference | `tests/connector-semantics.test.ts`, `tests/edge-semantics.test.ts`, `tests/edge-kinds.test.ts` |
| Round trip and file format | `tests/serialization.test.ts` |
| Hostile and malformed imports | `tests/import-validation.test.ts` |
| Undo, redo, drag granularity, coalescing | `tests/history.test.ts` |
| IndexedDB, autosave, failure modes | `tests/storage.test.ts` (`fake-indexeddb`) |
| Text layout, highlighting, SVG export, escaping | `tests/rendering.test.ts` |
| XSS through node content | `tests/code-card.test.tsx` |
| The privacy claim | `tests/privacy.test.ts` |
| 100 nodes / 180 edges | `tests/performance.test.ts` |
| The critical journey, in a browser | `e2e/critical-journey.spec.ts` |

The end-to-end test drives the real UI through the whole journey: build a diagram, connect and
number it, undo, redo, reload, export all three formats, delete locally, import, and edit again.

## Deliberately not built

Authentication, accounts, cloud sync, collaboration, comments, AI generation, template libraries,
and icon packs for any cloud provider. Each would be a reasonable product; none of them is this
one. Kept out of the way rather than designed for: Mermaid import/export, image nodes, and PWA
install.
