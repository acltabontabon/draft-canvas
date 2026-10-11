# Draft Canvas — agent instructions

Draft Canvas is a local-first React + TypeScript SPA built with Vite. The same editor ships on the
web, in Docker and in a Tauri 2 desktop app. No backend, accounts or network calls in editor code.

Make focused changes. Keep updates and final responses brief: what changed, what was checked, and
any blocker. Complete authorized work without unnecessary confirmation.

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
  `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`, `eval` and `new Function`. The offline
  service worker may fetch same-origin app assets and updates, never diagrams or IndexedDB content.
- Only `src/desktop/tauri/` imports `@tauri-apps/*`. Other code uses `DesktopApi` in
  `src/desktop/api.ts`; desktop-only code stays behind `__DESKTOP__`.
- Use `localStorage` only for tiny preferences through `src/lib/preferences.ts`. Documents use IndexedDB.
- `src/starters/` is data. `build.ts` derives connector semantics from `connectorSemantics.ts`.
  No hardcoded colors, fonts or personality; starters create ordinary nodes and edges.
- Commands live in `src/commands/registry.ts`, with jump targets in `search.ts`. Call existing store
  actions or camera methods, never document operations directly. Add an operation and store wrapper
  before naming a new command.
- Learn recipes pair an entry in `src/learn/recipes.ts` with a scene in `src/learn/scenes/`.
  Keep `src/learn/` React-free; drawing belongs in lazily loaded `src/ui/learn/`. Use actual UI labels.

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
- Connector visuals have two renderers: `canvas/DraftEdgeView.tsx` and `edges/describe.ts`.
  Update both for badges, dashes, chips or other visual changes. Continuation and agent previews
  are not exported and reuse the shared ghost routing, dash and marker helpers.
- Presentation is transient: `flowPlayback.stage` and `uiStore.presentation` are never saved,
  undone or exported. Key signals and contour halos to the active transition; play once and remove
  outdated motion. Trace node silhouettes through `canvas/emphasis.ts`, never a surrounding box.
- Camera movement decisions belong in pure `presentation/framing.ts`. While a move is in flight,
  `useFlowPlayback` judges against the requested camera. A presenter's pan sets `framing: 'manual'`;
  guided framing stays off until requested again.

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

## Architecture

Dependencies flow `ui/` → `canvas/` → `document/`; storage and export consume the document model.
Library and editor are states of `src/App.tsx`, with no router. Keep the editor's Vite `base: './'`.

`depth/`, `layout/` and `starters/` import only `document/`. `continuation/` also imports `render/text`;
`openPoints/` also imports `depth/`. `agent/` may consume these and rendering/export helpers, never UI
or store modules. `depth/c4.ts` shares C4 role and scope derivation with the editor and agent.

`www/` is a separate Vite project with its own lockfile and no shared app dependencies. Web assembly
copies `dist/` into `dist-web/editor/` unchanged. Keep marketing code out of the editor and website
assembly out of the editor's `vite.config.ts`.

## Conventions and docs

Use npm, 2-space indentation, single quotes, semicolons and trailing commas. Use oxlint, not Prettier.
Keep browser and test types in their separate TypeScript project configs. Comments explain why;
preserve comments recording past bugs.

Update guides when behavior changes. Docs filenames use lowercase kebab-case; conventional root
files keep their usual names. Performance tables live only in `docs/reference/performance.md` and
are generated by `npm run perf:publish`; edit prose outside their markers. Regenerate guide screenshots
with `npx tsx e2e/docs-screenshots.ts` when UI changes make them stale.
