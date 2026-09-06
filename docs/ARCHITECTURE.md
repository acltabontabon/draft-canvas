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
export/            .draftcanvas, SVG, PNG and GIF
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

## Semantic vocabulary

The product principle every new primitive, kind, and semantic gets measured against: **Draft
Canvas models architectural roles and relationships, not implementation technologies.** Describe
what something does and how it relates, not which vendor, framework, library, or runtime implements
it — Component/Adapter/Datastore/Queue, never Spring Controller/Kafka Consumer/PostgreSQL/AWS
Lambda. A technology name is a *label* a user types onto an existing primitive ("Datastore" with
text "Orders DB" and, if wanted, a second line "PostgreSQL"), never a reason to add a new one. The
test before adding anything: *if every technology in this architecture were replaced, would the
concept still make sense?* Component, Adapter, Interface, Datastore, Queue — yes. Kafka, Spring
Boot, PostgreSQL, AWS Lambda — no.

A second, narrower rule guards the vocabulary against a subtler failure than adding too much:
**never reuse a semantic element solely because its visual rendering is convenient.** Hexagonal's
starter once put "Inbound Port"/"Outbound Port" text on a connector's `condition` field — a
Condition means an `if`/`when` a branch applies, and a port designation isn't one; it happened to
render as a small bordered chip, which was the only reason it got picked. Visual similarity is not
semantic equivalence, and a wrong-but-convenient choice here doesn't just look odd — every future
capability that reads the document model (validation, quick actions, smarter auto-layout, exports)
inherits whatever the model actually says, not what a screenshot suggested it meant.

**Component** (`document/types.ts`'s `component`/`ComponentKind`) is this principle's first real
addition: a logical architectural building block *inside* a larger deployment or boundary — a
domain module, a use-case layer, a ports-and-adapters adapter — with none of Service's deployment,
network-boundary, or process-boundary implications. Kept deliberately small: `generic` (no kind
caption, same "unspecified" convention Service's own default kind follows), `module`, and `adapter`
— never a kind for what a label already says ("Repository," "Controller," "Use Case" are text a
user types onto a Component, not a fourth kind to add). Its rendering (`nodes/describe.ts`'s
`component()`) gives each kind its own small, one-sided departure from a shared plain body — Module
a tab stepping up from the top edge, Adapter a notch cut into the right — the same "one restrained
mark per kind" discipline Service's own kinds follow, just quieter throughout: no cap band ever, a
thinner shared stroke, `neutral` accent by default, and — per an explicit later pass — a noticeably
smaller default footprint than Service's own (`document/limits.ts`'s `componentWidth`/
`componentHeight`, ~13%/~18% under `nodeWidth`/`nodeHeight`). The size and weight differences are
what make Component read as *contained within* something else at a glance, before any label is
read (Adapter's notch is deliberately cut into *both* vertical edges, not one — see
`nodes/describe.ts`'s `componentAdapter` for why a single-sided notch baked in a "always faces
right" assumption a bidirectional primitive can't make); the kind-picker's miniature previews
(`canvas/componentOptions.tsx`) show these silhouettes
directly rather than a hand-drawn icon, via the same `ShapePreview` → `describeNode` pipeline
Service's own kind picker already uses — nothing to keep in sync by hand. For the capability
matrix, Component resolves to `service` (see `connectorSemantics.ts`'s `resolved()`) purely for
relationship *vocabulary* — the same "reads/writes/calls" verbs a Service uses — while `categoryOf`
keeps it as its own, permanent category, never silently folded away: see
[`docs/SEMANTICS.md`](SEMANTICS.md#node-categories).

**Label/Text** (`type: 'text'`, "Label with no box" in the palette) already existed and already had
every piece of generic node machinery this needed (move, resize, edit, duplicate, copy/paste,
undo/redo, theme/personality rendering) — what this pass formalized was the one guarantee that
makes it safe to use as a zone annotation next to opinionated primitives: it is `generic` in
`categoryOf`, so it can never become a real endpoint in the capability matrix no matter what it
sits near or is connected to, and it is never a substitute for an edge's own `semantic`/`label` — an
annotation like "Driving Adapters" and a relationship caption like "calls" are different concepts
that happen to both be text.

**Port/Interface** was investigated and deliberately *not* added as a primitive in this pass. The
concept is real (Hexagonal's inbound/outbound ports, a Component's provided/required interfaces,
plugin boundaries) and the eventual shape is probably a lightweight attachment on a Component/
boundary's edge — closer to the existing anchor/attachment system (`document/types.ts`'s
`EdgeAnchor`, `Attachment`) than a new independently-sized node — but building that cleanly needs
its own pass, not one folded into a vocabulary cleanup. Naming a port on an edge turned out not to
be a clean stand-in either — Hexagonal tried it (a plain `label` reading "Inbound Port"/"Outbound
Port"), and a later pass removed it: the override hid the connector's actual relationship
underneath, and rode the app's one *bolder* caption style while doing it, the opposite of the quiet
annotation a port name is supposed to be. Until a real Port/Interface concept exists, a starter
should let a crossing connector's own relationship word (`calls`, `uses`, …) do the talking instead
of naming the crossing itself — and, as ever, never reach for `condition` to fake the visual weight
a port name used to have.

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

## Architecture starters

`src/starters/` holds five authored opening compositions (Monolith, Modular Monolith,
Microservices, Event-Driven, Hexagonal) and the function that turns one into document elements. It
is a *starter*, not a template: everything it creates is an ordinary `DraftNode`/`DraftEdge`, and
nothing anywhere records that a node came from one. That is the whole design — there is no starter
object to keep consistent, no mode to leave, and no second way to edit what it made.

The module imports only `document/`, and is not part of the `.draftcanvas` format. Three rules
carry the weight:

- **Composition is authored, layout is not solved.** There is no auto-layout library here, and for
  five diagrams whose structure is known in advance that is the right answer: a solver produces
  something defensible, and a starter has to produce something *composed*. `catalog.ts` is literal
  coordinates; `compose.ts` is a handful of spacing constants, not an engine.
- **Relationships come from the matrix, never from the catalog.** `build.ts` runs every connector
  through `inferRelationship` and stamps `semanticsOrigin: 'inferred'`, the same way
  `insertWorkerOnEdge` and `addConsumer` do. A starter cannot state a relationship the rest of the
  app would disagree with, and changing a node's kind afterwards re-derives its connectors. A
  `StarterEdgeSpec` may still set an explicit `label` (Hexagonal's `Use Cases` → `Domain Model`/
  `Persistence Adapter`/`Integration Adapter` all read `uses`, since Component resolves through
  `service`'s matrix rows and `calls` is genuinely the wrong word for a plain internal dependency)
  — that overrides only what's displayed; the underlying `semantic`/`kind` are exactly as derived
  and re-inference-eligible as any other starter connector. Never `condition`: a Condition means a
  condition, and a relationship word isn't one — see "Semantic vocabulary" below. An earlier
  revision of Hexagonal used this same `label` to name the ports themselves ("Inbound Port"/
  "Outbound Port"); a later pass removed that, since it hid each connector's actual relationship
  behind a position in the architecture and rode the app's more prominent, bordered-chip caption
  style while doing it — the opposite of the "quiet annotation" it was meant to be.
- **A starter reaches for the primitive that's actually true, not the one that's already drawn and
  looks fine.** Hexagonal's Use Cases/Domain Model/Persistence Adapter/Integration Adapter are
  `component`, not `service` — none of them is independently deployable, and rendering them as
  Service purely because Service already existed and looked plausible was exactly the "convenient
  shape, wrong meaning" mistake "Semantic vocabulary" (below) exists to rule out.
- **Nothing here sets appearance.** No colour, no font, no personality — only `accent`, which is an
  enum the theme resolves. Every starter is therefore correct in both themes and all three
  Intentional Roughness presets without knowing they exist.

Insertion is `editorStore`'s `insertStarter`: `freeOriginFor` (one pass over the nodes, treating
boundaries as obstacles, unlike `placeNear`) picks a spot clear of existing content, and a single
`addNodesWithEdges` makes the whole architecture one undo entry.

## Command surface

`src/commands/registry.ts`'s `commandsFor(ctx)` is a pure function from the current
selection/mode/document to the commands that make sense right now — re-derived on every keystroke,
never registered ahead of time or kept in a store. Every command's `run` is one call into an
existing `editorStore`/`uiStore` action, so the palette introduces no second way to mutate the
document. The right-click context menu (`commands/contextMenu.ts`) is a second surface over the
identical command functions, filtered to a small per-target subset and excluding any command that
returns a `CommandStage` (a follow-up picker, e.g. "Connect to…") — it's deliberately flat, no
flyouts. The empty canvas's starter row (`ui/Editor/EmptyState.tsx`) is a third
surface over the same commands, for the same reason: two entry points that build their own
behaviour would eventually disagree about one of them.

One trap worth knowing: `CommandContext.editor` holds live *actions* but a *snapshot* of state, so
a command that creates something cannot then look it up in `ctx.editor.document` — that document
predates its own mutation. Such a command works from what the store action returned; see
`focusBounds` in `commands/search.ts`.

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

Authentication, accounts, cloud sync, collaboration, comments, AI generation, template galleries,
and icon packs for any cloud provider. Each would be a reasonable product; none of them is this
one. Kept out of the way rather than designed for: Mermaid import/export, image nodes, and PWA
install.
