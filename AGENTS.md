# Draft Canvas — agent instructions

Draft Canvas is a local-first React + TypeScript SPA built with Vite. The same editor ships on the
web and in a Tauri 2 desktop app. No backend or accounts; the only network code is owner-hosted live
collaboration in `src/collab/transport/`.

Make focused changes. Keep updates and final responses brief: what changed, what was checked, and
any blocker. Complete authorized work without unnecessary confirmation.

The product principle is **your architecture, your agents, your decisions**
([Principles](CONTRIBUTING.md#principles)): no account or server that sees diagrams, the person's own
agent, and every agent change reviewed before it lands. Design new features to keep it.

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, commands and the repository map;
[docs/index.md](docs/index.md) for guides and reference material.

## Verification

- **Docs only:** check formatting, links, anchors and referenced images. No tests, builds, lint or
  benchmarks unless requested. Preview rendered docs when layout matters.
- **Code, scripts or configuration:** run `npm run check` and focused checks for the changed behavior.
- **Browser tests:** full Chromium, Firefox and WebKit suites run in CI. Run focused local browser
  checks only when needed. `npm run check:full` is optional unless requested or needed for an issue.
- Report only checks actually performed; do not claim pending CI has passed.

## Common commands

```bash
npm run dev                  # editor on :5180
npm run check                # lint, tooling typecheck, build and unit tests
npm run desktop:check        # desktop build, Rust checks and version check
npx vitest run tests/history.test.ts
PLAYWRIGHT_BROWSER=chromium npx playwright test e2e/editing.spec.ts
```

Playwright starts its own dev server and reuses one already running on :5180.

## Implementation rules

The reasoning behind these rules is in [Architecture](docs/reference/architecture.md).

### Model and module boundaries

- `src/document/` imports neither React nor React Flow. It is the serializable file model.
- Node appearance belongs in pure functions in `src/nodes/describe.ts`. Canvas and export share
  its display list; do not add a separate JSX renderer for a node type.
- Wrap text only in `src/render/text/layout.ts`. The DOM renders the lines it produces.
- No network calls, dynamic code execution or webfonts in `src/`. The privacy test rejects `fetch`,
  `XMLHttpRequest`, `EventSource`, `sendBeacon`, `eval` and `new Function` everywhere, and
  `WebSocket`, `RTCPeerConnection` and `RTCDataChannel` outside `src/collab/transport/`, which only
  `src/collab/` may import. The offline service worker may fetch same-origin app assets and updates,
  never diagrams or IndexedDB content.
- Only `src/desktop/tauri/` imports `@tauri-apps/*`. Other code uses `DesktopApi` in
  `src/desktop/api.ts`; desktop-only code stays behind `__DESKTOP__`.
- Use `localStorage` only for tiny preferences through `src/lib/preferences.ts`. Documents use IndexedDB.
- Starters are `.draftcanvas` files in the public starters gallery
  (github.com/acltabontabon/draft-canvas-starters), not app code. `src/gallery/` reads them only
  after the person chooses **Load starters**; `src/gallery/remote.ts` is the only `fetch` in `src/`,
  to that repository only. Every file is checked against `catalog.json`'s SHA-256 and opened with
  `parseDocument` before it is kept. The gallery's style packs are `.draftstyle` files listed in the
  same catalog and held to the same rule, opened with `readStyleFile`; `tests/style-packs.test.ts` is
  their gate, and fails a pack that leaves any shape kind without a look. `tests/starter-files.test.ts` is the quality gate for starter
  files; `tests/fixtures/starters/` is a vendored snapshot (`npm run starters:fixtures`) and
  `tests/fixtures/starters-v1/` the frozen old catalog for routing and performance corpora.
  Browser journeys read their own pinned gallery, `e2e/fixtures/starters/` (`e2e/gallery.ts`): a
  refreshed snapshot must not rewrite them. Guide screenshots ask for the current one.
- Commands live in `src/commands/registry.ts`, with jump targets in `search.ts`. Call existing store
  actions or camera methods, never document operations directly. Add an operation and store wrapper
  before naming a new command.

### Documents, depth and history

- Read document `version` only in `src/document/migrate.ts`. Migrations touching graph content must
  cover every room: implement for one graph and wrap with `everyRoom` in `MIGRATIONS`.
- Add every root-only document field to `depth/tree.ts`'s `embed`, `editorStore.ts`'s
  `shallowEqualDocument` and `HistoryStack.ts`'s `sameContent`.
- Reach rooms only through `src/depth/tree.ts` and the store lens. The store's `document` is the
  current room, or the whole file by identity at the root. Use `fileOf` only for file persistence,
  file export, conflict resolution and document-wide limits.
- A room exists only while it contains a shape. Preserve `embed` and validation's empty-room handling.
- No side effects inside React state updaters; development mode may run them twice.

### Canvas and performance

- Keep `nodeTypes` and `edgeTypes` at module scope.
- Store selectors must return stable references. Wrap selectors that create arrays, objects or sets
  in `useShallow`, including filters that return a new collection only for some inputs.
- Per-node and per-edge selectors must not scan, allocate or touch the DOM on every store update.
  Use `src/canvas/EdgeLabels.tsx`, not React Flow's `<EdgeLabelRenderer>`.
- Node mounts must not update React Flow's store. It measures new nodes in a batch; call
  `updateNodeInternals` only on a real size change.
- Render handles in every mode, including presentation. Hide them with `visibility: hidden`, never
  `display: none` or opacity alone. Revealing a handle sets both `visibility: visible` and `opacity: 1`.
- Memoized routing and crossing plans must not retain planner scratch data through closures.
  Build returned lookup objects in module-level functions, as `planOf` in `crossings.ts` does.

### Open points, connectors and presentation

- Open points are root-only metadata attached by element id. They must not affect routing, node
  size or connector semantics. Their shared glyph is `openPoints/marker.ts`; use it in both canvas
  and export. Delete elements through `removeElements`, or prune attachments in the same operation
  with `pruneOpenPoints`.
- The marks above a shape's top-right corner (technology mark, attachment tab, open-point tab) are
  placed only by `document/markerRail.ts`, in one row. Never position one on its own, and draw each
  from its shared describe function (`describeAttachmentTab`, `describeMarker`) in canvas and export.
- Where a connector meets a shape is `anchorBandOf` and `bandSpan` in `document/queueGeometry.ts`,
  read by the router, the handles (`DraftNodeView`) and the layout alike. Never work out a point on
  a side as a fraction of the box by hand: a glyph's anchors sit on the glyph, its top and bottom
  ones spread along its reach, and a Service or Component glyph grows into the room its words leave
  (`standingOf` in `document/dataStoreGeometry.ts`: grown to fill the box, then lowered so the
  bottom points stay under its name), so anything that asks for a band passes what `bandWords`
  takes from the shape. `nodes/describe.ts` hands that geometry its line counts
  (`setWordsMeasure`); do not measure text anywhere else in `document/`. A shape whose drawing is
  not its box needs every one of its twelve points on what is drawn.
- Connector visuals have two renderers: `canvas/DraftEdgeView.tsx` and `edges/describe.ts`.
  Update both for badges, dashes, chips or other visual changes. Continuation and agent previews
  are not exported and reuse the shared ghost routing, dash and marker helpers.
- Presentation is transient: `flowPlayback.stage` and `uiStore.presentation` are never saved,
  undone or exported. Key signals and contour halos to the active transition; play once and remove
  outdated motion. Trace node silhouettes through `canvas/emphasis.ts`, never a surrounding box.
- Camera movement decisions belong in pure `presentation/framing.ts`. While a move is in flight,
  `useFlowPlayback` judges against the requested camera. A presenter's pan sets `framing: 'manual'`;
  guided framing stays off until requested again.

### Styles

- How a diagram is drawn is `DraftDocument.style` (`document/style.ts`), root-only and optional. Absent
  means the diagram is drawn in the style in use on this device; nothing stamps a style on open. Changing it is
  one undo step through `editorStore.setDocumentStyle`.
- Renderers read one `ResolvedStyle` (`render/style/resolve.ts`) and nothing else about style: nodes
  through `DescribeContext.style`, both connector renderers, the markers and every export. Canvas
  components get it from `canvas/useDiagramStyle.ts`; `renderDocumentSvg` resolves the document's own.
- A style changes how a shape looks, never its size, anchors, routing or meaning. Anything that
  measures a shape asks `sizingContext()` in `nodes/describe.ts`, never a styled context.
- Every style from outside (file, collaborator, profile, pack) goes through `normalizeStyle`, which
  must stay free of the DOM so it runs in the agent worker. Colours are checked for contrast when
  resolved (`render/style/scheme.ts`), not in `document/`.
- A style that names a canvas colour dresses the whole editor: `schemeTheme` works the panels' and
  hairlines' colours out from the canvas, and `canvas/useEditorDress.ts` puts the theme on
  `.dc-editor`. Dialogs, menus and Home are outside it and stay the app's. CSS that reads the theme
  by attribute inside the editor must ask the editor's (`.dc-editor[data-theme]`), not the root's.
- A style's backdrop (`DocumentStyle.backdrop`) is one drawing repeated behind the diagram: paint only,
  never selected, routed round or measured. `render/style/backdrop.ts` makes the one tile the canvas
  (`canvas/StyleBackdrop.tsx`), every export and every preview repeat; do not draw it a second way.
- Dashes and open arrowheads encode what a connector means (`edges/kindStyle.ts`). A style never
  offers them, nor anything that would move a route, such as arrowhead size.
- An SVG becomes a drawing only through `import/svgArt`, which reads the file with its own small
  reader (`markup.ts`): no `DOMParser`, no document, so it needs no DOM. What is stored is path data and colours (`StyleAsset`); no markup, URL or text is kept,
  so there is nothing to sanitise later. `render/style/art.ts` places a drawing by scaling its
  numbers into the box the built-in drawing took, and keeps the shape's own words.
- How a new shape starts ("Save as my default Service") is a device preference too
  (`styleStore.starts`): fields put on the shape when `createAt` makes it, never read when one is drawn,
  so it is no part of a style.
- A person's own styles are a device preference (`store/styleStore.ts`, IndexedDB
  `draft-canvas-styles`), never read by a renderer. A new diagram is stamped with a copy
  (`deviceStyle()`) by whoever creates it. With a diagram open, Appearance is the panel docked beside
  the canvas (`ui/Editor/StylePanel.tsx`, `uiStore.stylePanelOpen`, transient), never a dialog over it,
  reached from the status bar, the canvas's right-click and ⌘K, and it holds the canvas's own settings too.
  While it is open the editor is in its studio state (`.dc-editor[data-studio]`): the tools, Present and
  Share, the Depth chip and the status bar are hidden, so new chrome must say whether it steps back too:
  the diagram is the preview. The desktop Settings page is the same `AppearanceSettings`, for Home. Appearance takes the open diagram along with a
  change only while it is drawn in the style being changed (one coalesced undo step); a diagram with
  a different style changes only through an explicit "Use my style in this diagram". Settings → Appearance previews with `renderDocumentSvg`, never a drawing of
  its own.

### Tidy up

- Tidy up is the gentle cleanup (`agent/tidy.ts`): it never lays a view out again and never moves a
  shape outside its scope. Layout from scratch stays in Arrange.
- Its preview lives in `uiStore.tidyPreview`, never the document, history or autosave. Only
  `editorStore.commitTidy` applies it, as one undo step, and only to the room it was worked out from.
- Arrange's proportion rules (wider boxes for long names, gaps sized to their captions, a reading
  direction weighed by how it fits a screen) belong to Arrange and new layouts, never Tidy up. Its
  preview lives in `uiStore.arrangePreview`; only `editorStore.commitArrange` applies it.
- Every way into Arrange or Tidy up (palette, menus, the desktop menu, Nodi's skills) goes through
  `commands/arrange.ts`, which shows a preview first. The work runs on the agent worker
  (`agent/layoutPlan.ts` through `offThread.ts`, Cancel included) and is bounded by a deterministic
  work budget (`route.ts`'s `withBudget`), never a wall-clock deadline: the same diagram gives the
  same preview on any machine, and a result that ran out says `partial`. The budget must bind before
  the far-off clock backstop (`layoutPlan.ts`), which is only a hang guard; a run it stopped also
  says `timedOut`.

### Outage walk

- An outage is read from the drawing alone (`traffic/outage.ts`, over `analyzeTraffic`'s reading of
  how work travels). It never states a rate, latency, likelihood or capacity, and where the drawing
  is silent it asks a question rather than guessing. `tests/traffic/outage.test.ts` holds that line.
- The walk is a view: `editorStore.outage` and everything `store/outage.ts` derives from it are never
  saved, undone, shared or exported. Readings are memoized per graph; a drag must not recompute them.
- It changes nothing by itself. A question's answers are the person's edits: a fix is one existing
  store action through `commands/outage.ts` (one undo step), and "Keep as open point" is `addOpenPoint`.
- Every way in (status bar, palette, shape menu) goes through `commands/outage.ts`. `OutageLayer` is
  canvas chrome drawn with `canvas/sketchPaths.ts`; product behaviour lives only in
  `traffic/technology.ts`, as documented defaults matched on an assigned product name. Every fact
  there names the vendor page it was read from and the day it was checked; a note that quotes one
  carries the source (`tests/traffic/technology.test.ts`).
- What is taken down is a shape, a Boundary or a connector (`OutageTarget`); a connector leaves both
  ends up and is read by the same rules, never a second set. Its notes say "can't be reached".
- A flow is read against the outage (`OutageFlow`), and is the only source of order: a step breaks
  only where its own connector does, and half-done work "has happened" only where a flow puts it
  before the step that fails. Without one, the note says "if".
- The list before anything is picked (`traffic/review.ts`) is `outageOf` repeated: no score, no
  severity, and no sentence a person would not get by taking that one thing down.
- Agents get the same reading through `read_diagram`'s `outage`, as facts and open questions.

### Sketches and Smart Ink

- Sketches (`DraftInk`) are per-room annotation in `ink`, absent when empty. They never take part in
  routing, layout, Arrange, Tidy up, semantics, outage walks or agent reads, and nothing turns one into a
  shape except an explicit Smart Ink conversion through `editorStore.inkToShape`/`inkToConnector`.
- `src/ink/` imports `document/` only and stays free of React, the store and the DOM. Geometry
  (`recognize.ts`) and meaning (`interpret.ts`) stay apart; Smart Ink offers only existing shape kinds.
- Draw ink with `render/ink.ts` in both canvas and export. A stroke in progress is written to the DOM
  directly (`canvas/liveInk.ts`), never through React state, and kept as one stroke at pen-up.

### Architecture model, checks and the CLI

- What a diagram describes is read through `model/` (`modelOf`): parts, boundaries, relations with
  Junctions seen through, every room. It is derived and never stored; do not add a persisted copy,
  and do not work the same things out again elsewhere. It never follows a Junction's `link`.
- `document/fieldClasses.ts` is the one table of what each field means, checked against the types:
  a new `DraftNode`, `DraftEdge` or `Attachment` field does not compile until it is classed there.
  A list of "the fields that carry meaning" anywhere else reads `ARCHITECTURE_NODE_FIELDS`.
- A finding (`checks/finding.ts`) is never written into a diagram, history or a collaboration
  session. Its class says how much is known: an incomplete read is `tool-error`, never `drift`;
  "declared but not drawn" is `potential-drift` and never fails a check by default.
- Checks reach a repository only through a `RepoReader` (`checks/evidence/reader.ts`) someone
  handed them. `src/checks/` touches no file system. Findings carry paths, names and line numbers,
  never file contents. A name found in a file means "anchor intact", never "relationship verified".
- `cli/` is the Node side: no network, no child process, no environment read
  (`tests/privacy.test.ts`), and the only write is the `--output` file. Exit codes and the `schema`
  of each `--json` report are a public interface: add fields, never repurpose them.
- `agent/review.ts` re-exports `checks/review.ts`. What `read_diagram` returns must not change
  when a check is added: new checks go in `checks/rules.ts`.

### Linked junctions

- A Junction's group is `DraftNode.link`, an opaque id on the Junction, and nothing else. Do not add
  a table of groups or key anything on the label: two groups may read "A". The label is each
  member's `text`; only `renameJunctionGroup` writes it on all of them.
- A link is not a connector. Routing, flows, Arrange, Tidy up, semantics, outage walks, sequence
  export and image export must not read it. The ring a linked Junction wears is canvas chrome in
  `styles/junctions.css`, never a shape in `nodes/describe.ts`.
- `src/junctions/` imports `document/` and `depth/` only. Validation reads `link` on its own, never
  against other Junctions: a shared session checks one node at a time, and a group of one is valid.
- Every way to travel (the Go key, the peek card, menus, search, a click while presenting) goes
  through `commands/junctions.ts`. Where the camera stops and how it moves are decided in
  `junctions/journey.ts`; what is framed in `junctions/destination.ts`, which must stay bounded.
- The peek (`uiStore.junctionPeek`), a counterpart in hand (`junctionPlacing`) and the trail
  (`junctionTrail`) are transient: never saved, undone, shared or exported. Following a Junction
  leaves nothing selected and records no history entry.
- A Junction's selectors read `store/junctions.ts`, two map lookups. Previews draw only the context
  through `canvas/junctionPreview.ts`, which keeps a bounded number and drops one when its room changes.
- Copies follow `regroupCopiedJunctions` in `document/operations.ts`: a group copied together gets a
  new link, a Junction copied alone keeps its own.
- Agents keep the same rules through `settleJunctionLabels` (`junctions/groups.ts`), run once after an
  update's ops: a label set on a linked junction is the group's, in every view; a junction joining a
  group takes its label. A change that reaches other views is listed by `diffForReview` with its view.

### Live collaboration

- `src/collab/` is React-free and store-free: it imports `document/`, `depth/` and `lib/` only (and its own
  `transport/`). The editor meets it in `store/collabBridge.ts`; session state for the UI lives in the
  transient `store/collabStore.ts`, never saved, undone or exported.
- The owner's file is the single authority. Every incoming change goes through `collab/sanitize.ts`,
  in both directions. A root-level `DraftDocument` field must be handled by `collab/diff.ts` and
  `collab/apply.ts`, or listed as not shared in `tests/collab/untrusted.test.ts`.
- Remote changes enter the editor only through `editorStore.applyRemote`: no history entry, and never
  while a gesture is held (the session waits). While shared, history entries record `keys` and undo is
  selective (`collab/selective.ts`). A guest's copy is opened with `openCollaborative` and never autosaved.

### Agent integration

- Agent previews stay in `uiStore.agentPreview` and `desktop/agentActivity.ts`, never the document,
  history or autosave. Only a commit through `host/agentBridge.ts`'s `applyToFile` or a shell file
  write changes a diagram.
- Proposal previews follow the same rule. `ProposalPanel.tsx` sets `uiStore.proposalPreview` from
  its dry run and clears it on Accept, Reject, Dismiss, Close, proposal switches and document switches.
  Accept is the only `applyToFile` that commits the proposal.
- Keep `src/agent/` free of React, the store and DOM access, including module-load side effects.
  The worker must load without `document` or `window`; preserve worker-safe dependencies.
- Tool schemas come from `src/agent/schema.ts`. Regenerate `src-tauri/mcp/tools.json` with
  `npm run agent:schemas` when schemas change.
- `skills/draft-canvas/` is compiled into the desktop app (`src-tauri/src/agent/skill.rs` lists every
  file) and installed into agents' skill folders. Any change to it needs a new `metadata.version` in
  its `SKILL.md` and a new entry in `PUBLISHED` there, so installed copies are replaced. Its checker
  restates the app's vocabulary; `tests/agent-skill.test.ts` keeps the two equal.

## Architecture

Dependencies flow `ui/` → `canvas/` → `document/`; storage and export consume the document model.
`canvas/`, `commands/` and `store/` import no `ui/` modules except the shared primitives in `ui/common/`
and the presence hooks in `ui/collab/`. The theme and personality hooks live in `theme/`, and shared
labels and presets in `lib/`.
Library and editor are states of `src/App.tsx`, with no router. Keep the editor's Vite `base: './'`.

`depth/` and `gallery/` import only `document/`; `traffic/` also imports `model/`'s loop finder; `layout/` also imports `edges/bundles`. `model/` imports `document/` and `depth/`; `checks/` imports those, `model/` and `traffic/`. `junctions/` imports `document/` and `depth/`. `collab/`
imports `document/`, `depth/` and `lib/`. `history/` imports `document/` and `depth/`, plus `collab/selective`'s
`changeKeys`, which records what an edit touched while a session is live. `continuation/` also imports
`render/text` and `edges/` routing helpers; `openPoints/` also imports `depth/` and `render/` types. None of these import UI, canvas or
store modules. `agent/` may consume these and rendering/export helpers, never UI or store modules. `depth/c4.ts` shares C4 role and scope derivation with the editor and agent.

`tests/layering.test.ts` holds these rules and fails on a new import cycle. A new exception is added there,
with its reason, in the change that needs it. Pure helpers a hook module shares with a lower layer live
in a module of their own (`presentation/steps.ts`), never in the hook's file.

`www/` is a separate Vite project with its own lockfile and no shared app dependencies. Web assembly
copies `dist/` unchanged into `dist-web/app/` (app.draftcanvas.dev). Never set
`Cross-Origin-Opener-Policy` on the app: the diagram handoff from the retired old address needs `window.opener`. Keep marketing code out of the editor and website
assembly out of the editor's `vite.config.ts`.

## Conventions and docs

Use npm, 2-space indentation, single quotes, semicolons and trailing commas. Use oxlint, not Prettier.
Keep browser and test types in their separate TypeScript project configs. Comments explain why;
preserve comments recording past bugs.

Update guides when behavior changes. Docs filenames use lowercase kebab-case; conventional root
files keep their usual names. Performance tables live only in `docs/reference/performance.md` and
are generated by `npm run perf:publish`; edit prose outside their markers. Regenerate guide screenshots
with `npx tsx e2e/docs-screenshots.ts` when UI changes make them stale.
