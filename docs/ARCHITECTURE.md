# Architecture

Draft Canvas is a single-page React application with no backend. This document explains how it is
put together and, more usefully, why each boundary is where it is.

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
  document/     types · factory · operations · flow · edgeSemantics · validate · migrate · limits
  storage/      DraftRepository · IndexedDbRepository · MemoryRepository · autosave
  history/      HistoryStack
  render/       the shared renderer (see below)
    text/       fonts · measure · layout
    code/       highlight · theme
    svg/        element · emit · markers · document
    png/        rasterize
    theme/      tokens
  nodes/        describe.ts — every node's appearance, as pure functions
  edges/        routing.ts · describe.ts
  canvas/       Canvas · DraftNodeView · DraftEdgeView · projection · snapping · presets
  presentation/ useFlowPlayback
  store/        editorStore · uiStore · selectors · useDocumentSession
  ui/           Library · Editor · common · theme
```

## The idea that shapes everything: one renderer

The canvas and the file exporter do not draw things twice.

```
DraftNode ──describeNode()──▶ DisplayList ──emit()──▶ SvgEl tree ──┬─▶ serialize() ─▶ on-screen
                              (pure)                               └─▶ serialize() ─▶ .svg / .png
```

`nodes/describe.ts` turns a node into a **display list** — rectangles, ellipses, paths, text
blocks, code blocks. `render/svg/emit.ts` turns that into an SVG element tree, and
`render/svg/element.ts` serializes it to a string. The canvas paints that string; the exporter
writes it to a file.

The alternative — JSX for the screen and a separate exporter for files — is the thing that always
rots. A month later somebody adjusts a padding value in one and not the other, and nobody notices
until an exported diagram looks wrong.

Consequences worth knowing:

- **Interactive chrome cannot be expressed in a display list.** Handles, resize frames, selection
  rings and inline editors live in React and CSS. That is not an oversight; it is how editor
  furniture is guaranteed never to appear in an exported image.
- **Node appearance is a pure function**, so it is unit-testable without a browser.
- Node visuals go through `dangerouslySetInnerHTML` with markup from our own serializer, which
  escapes every character of user text. `tests/code-card.test.tsx` proves a `<script>` in a label
  stays inert text.

### Text is laid out exactly once

`render/text/layout.ts` wraps text into lines. **Nothing else ever wraps.** The DOM renders the
lines it produced, one `<text>` per line, and so does the exporter. Two layout engines would agree
most of the time, which is worse than not agreeing at all, because you would only find out from a
customer's screenshot.

Fonts are system stacks only. Nothing is fetched, so the app works offline — and, decisively, an
SVG rasterized through an `Image` into a `<canvas>` can still resolve its fonts. A webfont would
silently fail there and every PNG would come out in the wrong typeface. Exported `<text>` carries
`textLength`, so a diagram opened on a machine with different metrics cannot reflow out of its box.

### Code cards

`render/code/highlight.ts` runs refractor and flattens its tree into one token list per line.
That flattening is what makes SVG export possible: a nested element tree cannot become `<tspan>`s,
but `{ text, scope }` per line can be rendered identically as DOM spans and as SVG tspans. Colours
come from one map in `render/code/theme.ts` that both backends read.

Monospace makes the geometry free: a token's x position is `charWidth × column`, so the code path
needs no measurement at all and is exactly reproducible.

### Edges are the one exception to "one renderer"

Node appearance is unified through `describeNode`; edge appearance is not. `edges/describe.ts`
(`describeEdge`) is the pure describer the SVG exporter calls, and `canvas/DraftEdgeView.tsx` is
an independent, hand-rolled React implementation of the same connector — path, label, step badge,
async dash, condition chip. They share geometry (`edges/routing.ts`) and marker defs,
but nothing enforces that a visual addition to one is mirrored in the other. This was true before
Flows existed and remains true after; it is a known, accepted gap, not an oversight to "fix" in
passing — unifying it would mean either giving React Flow's edge renderer a pure display-list
input (a real, larger change) or re-deriving on-screen interactivity (hover, inline editing,
drag-to-select) from a description format not built for it. If you add a new visual to a
connector, add it in both places.

## Canvas boundary

The zustand store owns the `DraftDocument`. React Flow is a controlled view of it.

- `canvas/projection.ts` derives React Flow's arrays and **preserves object identity** for nodes
  whose geometry has not changed, so one node moving re-renders one node.
- `node.data` carries only `{ id }`. Node components subscribe to the store themselves, so editing
  a node's text does not touch the projected array at all.
- The projection is computed during render, not synchronised in an effect, so a document change
  costs one render rather than two.

**The document is not written during a drag.** Position changes stream in per frame and are applied
to the rendered nodes for smoothness, but the document is only updated when the gesture ends. One
rule buys three things: one drag is one undo entry, autosave cannot fire sixty times a second, and
there is no per-frame history to coalesce.

### Connectors

`edges/routing.ts` is the only module that calls React Flow's path helpers, and both the live edge
component and the exporter call it — so an exported connector traces exactly the path on screen.

Endpoints are computed from node rectangles rather than from React Flow's measured handles:
`getEdgePosition` needs an internal node with measured handle bounds, which an exporter cannot
have. Owning the anchor maths means one implementation for both, and automatic re-routing for free.

Two details that were bugs first:

- Handles are rendered in **every** mode, including presentation. React Flow resolves an edge's
  endpoints through them; a node without handles silently loses all its connectors.
- Dropping a connection anywhere on a node's body connects to it. React Flow only reports a target
  within its connection radius of a handle, so `Canvas.tsx` hit-tests the drop point itself.

## History

Snapshot-based, with structural sharing. Every operation in `document/operations.ts` returns a new
document that reuses untouched nodes, so an entry costs roughly what actually changed — on the
order of a kilobyte for a move, in a hundred-node document.

Command/inverse-command history was the alternative. It halves the memory and doubles the surface
area: every operation needs a second, inverse implementation, and a bug in one silently corrupts a
diagram rather than merely drawing it wrong.

- `beginInteraction` / `endInteraction` bracket a gesture into one entry.
- Entries sharing a `coalesceKey` inside a short window merge, so typing a name is one undo.
- A gesture that changed nothing leaves the document identical by reference, and no entry is made.
- Viewport changes are persisted but never recorded — nobody wants undo to reverse a scroll.

Side effects must never run inside a React state updater. React invokes updaters twice in
development, which recorded every drag twice and made a single undo appear to do nothing.

## Persistence

Two IndexedDB stores. `documents` holds summaries; `bodies` holds the documents. The library lists
titles and timestamps without deserializing a single canvas, which is what keeps the landing screen
instant when you have twenty diagrams with code cards in them.

Autosave (`storage/autosave.ts`) debounces at 700 ms with a 4 s ceiling, never runs two writes at
once, and flushes on `visibilitychange` and `pagehide`. `beforeunload` is deliberately avoided: it
disables the back/forward cache.

The status indicator shows "Saving…" only if a write is still running after 300 ms and holds
"Saved locally" for 1.4 s, so quick saves do not flicker. It says "Unsaved changes" while an edit
is queued, because saying otherwise would be a small lie about the one thing the user is trusting.

Failures degrade rather than destroy: IndexedDB unavailable falls back to an in-memory repository
and the UI says so plainly; a quota error surfaces a message telling the user to export; a corrupt
record is repaired through the same validator as an imported file.

## Flows and presentation

A `DraftFlow` is a narration layer over connectors that already exist — it never duplicates a node
or an edge, only orders references to them. `document/flow.ts` holds the pure operations;
`presentation/useFlowPlayback.ts` is where playback meets React Flow's viewport.

A `DraftFlowStep` was originally always "one connector" (`edgeId`). It can now also carry
`extraEdgeIds`/`extraNodeIds` — more members the step spotlights beyond that one connector's own
endpoints — and an explicit `viewport`, shown verbatim instead of the usual auto-fit-to-bounds. A
step with `extraNodeIds`/`extraEdgeIds`/`viewport` but no `edgeId` (a "frame" step) is not a special
case in the data model: `stepIndexOf`/`explainEdgeTier`/`explainNodeTier` treat every member of a
step identically regardless of whether it arrived via `edgeId` or an extras array, and playback
resolves a step's members once (`resolveFlowStep` in `useFlowPlayback.ts`) rather than branching on
which fields happen to be set.

This is a deliberately different concept from **Focus Mode** (`store/editorStore.ts`'s
`FocusState`):
Focus is an arbitrary, unordered highlight the user can reach for in edit mode at any time, with no
relationship to a Flow. A frame step is an ordered member of a specific `DraftFlow`, only visible
during that flow's playback. Reaching for `FocusState` to model "a step with several members" would
have collapsed two things that only look similar — one is a story, the other is a spotlight — so
the two stayed separate, and `DraftFlowStep` grew a richer shape instead.

## Untrusted input

`document/validate.ts` is the only door into the document model, used for both imported files and
records read back from IndexedDB. Its policy is **repair, don't reject**: a diagram with three
broken edges opens with the other ninety-seven intact, and says what it dropped. Only an
unrecognisable file, or one written by a newer format, is refused.

It enforces hard caps (file size, element counts, string lengths), clamps coordinates, strips
control characters, renames duplicate ids, prunes dangling edges, and detaches cyclic groups.

Colour is an enum, not a string, so no user-supplied value ever reaches an SVG `fill`.

## Schema evolution

`document/migrate.ts` is the only place a version number is read. Adding a format version means
bumping `CURRENT_VERSION` and adding one function there. Nothing in the UI branches on a version.

## Testing

| Layer | Where |
| --- | --- |
| Document model, operations, flows | `tests/document.test.ts`, `tests/flow.test.ts` |
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
