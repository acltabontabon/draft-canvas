# What comes next, and in what order

The four drawing and explanation milestones below are implemented for 1.13.0. The hosted Chromium, Firefox and WebKit acceptance matrix and
Desktop CI passed. The human observations described in
[the usability protocol and validation record](explanation-usability.md) remain separate manual
acceptance items; automated results do not establish reader comprehension. No editor telemetry is added.

| Milestone | Outcome | Main implementation |
| --- | --- | --- |
| 1. Trace a flow | Choose a story's connectors, then finish once | [Atomic flow operation](../../src/document/flow.ts), [trace controls](../../src/ui/Editor/FlowTraceBar.tsx) and canvas preview |
| 2. Complete example | Play and edit Order processing | [Ordinary starter data](../../src/starters/order-processing.ts) with fresh IDs |
| 3. Intentional sharing | Choose a level or flow introduction | [Optional fragment metadata](../../src/share/link.ts) outside the document schema |
| 4. Arrange selection | Tidy a local area without moving its neighbors | [Scoped arrangement](../../src/agent/arrange.ts) with fixed outside content |

The earlier rationale below is retained for reference. The browser-file experiment was removed
before 1.13.0 publication; web saving uses autosave plus Import and Export. Agent entry point and review remains future work. No document schema migration is needed.

## A. Browser file access (removed before release)

The linked-file experiment added permissions, recovery-versus-disk conflicts and a second saving
model. It was removed before 1.13.0. Browser diagrams auto-save locally; Import opens a portable copy
and Export creates one. Desktop Open, Save and Save As remain native file operations.

An unused v4 IndexedDB store is retained so a development build's saved diagrams still open; the
editor does not read or use its old file links.

## B. Read-only share links (shipped in 1.12)

**Scope.** **Share → Copy link** puts a versioned, compressed snapshot of the current document in the
URL fragment (`#d=<version>.<deflate-raw, base64url>`). Opening such a link shows the diagram
read-only, with **Make an editable copy**, which imports it into the Library as a new document and
never touches anything already there. No server, no shortener, no live updates: a snapshot.

**What goes in.** The whole file as `serializeDocument` writes it — every room, notes, flows, open
points, settings — minus `metadata.id`, timestamps, `projectId`, and the background image (a blob, and
usually large). Nothing from the desktop shell or agent configuration, which are not in the document.

**Honesty.** A fragment is not sent in the HTTP request, but the page's own script reads it, and
anyone holding the link holds the diagram. The UI says so ("anyone with this link can see the
diagram") and never uses the words encrypted or private. Nothing logs the fragment: the app has no
telemetry, and the service worker must not cache URLs with fragments (it does not; fragments never
reach it).

**Limits.** A hard ceiling on the encoded length (32 KB is safe across browsers and chat tools; the
UI offers **Export a file instead** past it), decompression bounded to `LIMITS.maxFileBytes` before
parsing, and the result goes through `parseDocument` like any import. Base path and hash routing:
the app has no router, so the fragment is free; the landing page's forwarder must ignore it.

**Acceptance.** A shared snapshot renders identically to its source in both themes; a malformed,
oversized or truncated fragment shows one plain error and an empty Library, never a crash; making a
copy leaves the recipient's existing diagrams byte-identical; the link works at `/draft-canvas/editor/`
and at a Docker root path.

**Modules.** New `src/share/` (encode/decode, imports `document/` and `export/project.ts` only),
`App.tsx` (read-only mode is a `mode` on the editor store, like presenting), the command registry, the
toolbar, `docs/guides/saving-and-sharing.md`, `docs/reference/privacy.md`.

## C. Editable PNG and SVG (shipped in 1.12)

**Scope.** An **Include editable diagram data** checkbox in the Image export (default on for SVG, off
for PNG, remembered as a preference). SVG carries the serialized document in a `<metadata>` element;
PNG carries it in an `iTXt` chunk keyed `draftcanvas`. Import recognises both and opens the embedded
document.

**What is embedded.** The same payload as the share link (B), scoped to what the picture shows: the
exported room and every room inside it, with notes and open points, not the rooms above it. A
selection-only export embeds the selection's shapes and the connectors between them. The dialog says
in one line what the payload holds when it differs from the pixels.

**Honesty and safety.** README renderers, chat tools and image optimisers strip metadata routinely;
the docs say editability survives some tools and not others, and the ordinary visual-only export
stays the default for PNG. Import validates the payload version and size before `parseDocument`; an
SVG is read as text and never inserted into the DOM.

**Acceptance.** Export → import round-trips a document with rooms, notes and open points; a PNG
passed through an optimiser that strips chunks imports as "no diagram data in this image" rather than
failing; the visual output is byte-identical to today's when the box is unticked.

**Modules.** `src/render/svg/document.ts`, `src/render/png/rasterize.ts` (chunk writer), `src/export/`,
`LibraryScreen.tsx` import, `docs/guides/saving-and-sharing.md`.

## D. One bounded import: Mermaid flowcharts (shipped in 1.12)

**Scope.** `graph`/`flowchart` only: nodes with the common shape brackets, edges with and without
labels, subgraphs as boundaries, direction hints for the initial layout. Everything else (classes,
click handlers, styles, other diagram types) is reported, not silently dropped: the import shows a
list of what it could not represent before the diagram lands.

**Meaning.** Node shapes map to Draft Canvas kinds where the mapping is safe (a cylinder is a Data
Store, a stadium is an Actor-like participant); everything else is a Service with the label kept.
Relationships come from the capability matrix as they would for a hand-drawn connector, with the
Mermaid edge label kept as the connector's label. Layout uses `src/layout/` (the agent's layered
layout) so the result is tidy and editable, then autosaves like any document.

**Not claimed.** Round-tripping (the Mermaid export is of *sequence* diagrams, a different thing),
lossless import of anything, or draw.io in this pass. Parsing is a hand-written recursive-descent
parser over the subset; no Mermaid library, no `eval`, no fetching of anything.

**Acceptance.** A corpus of representative flowcharts imports with every node and edge present and
labelled; unsupported constructs each produce one warning line; a hostile input (deep nesting, huge
labels, thousands of nodes) is refused by `LIMITS` before layout runs.

**Modules.** New `src/import/mermaid/` (imports `document/` and `layout/`), `LibraryScreen.tsx` import
picker (`.mmd`, pasted text), `docs/guides/saving-and-sharing.md`.

## E. Agent entry point and review

**Scope.** On the desktop, one obvious door: Home's **Connect an agent…** (shipped in 1.12) grows a
status line — off, on, connected, with the last request's diagram — and the editor's status bar shows
where an agent's change will land (which diagram, which room) while a proposal is pending. The
proposal review keeps its visual diff and explicit Accept. Verified clients are named as such
(Claude Code on macOS end to end; Cursor by configuration only), and nothing else is advertised.

**Separately scoped later.** Code-to-diagram and PR-to-diagram are two workflows with their own
provenance rules: what code was read, by whom, and what the agent inferred. Neither belongs in this
item, and the docs keep saying that the client agent reads the code, not Draft Canvas.

**Acceptance.** A first-time user finds agent setup from Home in one click without it being in the
way of drawing; a pending proposal says which diagram it targets before it is opened; the web build
still contains no agent UI.

**Modules.** `src/desktop/ui/DesktopHome.tsx`, `DesktopStatus.tsx`, `ProposalPanel.tsx`,
`src/desktop/agentActivity.ts`, `docs/guides/connect-an-ai-agent.md`.
