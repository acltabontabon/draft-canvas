# Draft Canvas — working notes

Draft Canvas is a local-first React + TypeScript SPA (Vite) for explaining software visually.
No backend, no accounts, and no network calls in the editor's code. The same editor ships as the web
app, a Docker image, a Tauri 2 desktop app (`src-tauri/` + `src/desktop/`) and a VS Code extension
(`vscode-extension/`). [`CONTRIBUTING.md`](CONTRIBUTING.md) has the repository map and how each
platform saves a document.

## Commands

```bash
npm run dev        # dev server on :5180
npm run build      # tsc -b && vite build
npm run lint       # oxlint
npm test           # vitest run
npm run e2e        # playwright (npm run e2e:install once first)
npm run check      # lint + e2e/benchmark/demo typecheck + build + unit tests — run this before calling work done
npm run site:dev   # the landing page (www/) alone, on :5280
npm run build:web  # editor + landing page, assembled into dist-web/ the way Pages serves it
npm run e2e:web    # the assembled artifact, served at /draft-canvas/ like production
npm run desktop:dev    # the desktop app with hot reload (needs Rust + Tauri prerequisites)
npm run desktop:check  # desktop web build + cargo fmt/clippy/test + version check
npm run e2e:desktop    # the desktop screens against a faked shell, no Rust needed
```

Single test / focused runs:

```bash
npx vitest run tests/history.test.ts          # one unit test file
npx vitest run -t 'coalesces'                 # by test name
npm run test:watch                            # watch mode
npx playwright test e2e/editing.spec.ts       # one e2e spec
npx playwright test --debug                   # headed, inspector
```

Playwright starts the dev server itself (`webServer` in `playwright.config.ts`) and reuses one
already running on :5180.

## Rules that are load-bearing

Each of these has a failure mode that is silent, delayed, or both.

- **`src/document/` imports neither React nor React Flow.** It is the serializable model that
  `.draftcanvas` files contain. Keeping it framework-free is what stops a library upgrade from
  breaking user files.
- **Node appearance goes in `src/nodes/describe.ts`, as pure functions.** Do not write bespoke
  JSX for a node type. The canvas and the file exporter render the same display list; a second
  renderer would drift and nobody would notice for weeks.
- **Never wrap text anywhere but `src/render/text/layout.ts`.** The DOM renders the lines it
  produced. Two layout implementations would agree most of the time, which is worse than not
  agreeing at all.
- **Never add a network call in `src/`.** `tests/privacy.test.ts` fails the build on `fetch`,
  `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`, `eval`, or `new Function` anywhere
  in the app's own code. The production CSP (injected by a Vite plugin in `vite.config.ts`) sets
  `connect-src 'self'` — no request to any other origin is possible. The one legitimate
  same-origin exception is the offline Service Worker (`vite-plugin-pwa`), which fetches
  the app's own assets and checks for updates in the background; it never touches IndexedDB or
  canvas content. No webfonts either — an SVG rasterized through `<canvas>` cannot resolve them,
  so every PNG would export in the wrong typeface.
- **Only `src/desktop/tauri/` imports `@tauri-apps/*`.** Everything else reaches the native side through
  the `DesktopApi` interface (`src/desktop/api.ts`), which is what lets `e2e/desktop/` and
  `tests/desktop/` run the desktop screens against a fake. `tests/privacy.test.ts` enforces it, and
  desktop-only code sits behind `__DESKTOP__` so the web build compiles it out.
- **`localStorage` is only for tiny preferences**, and only through `src/lib/preferences.ts`.
  Documents go in IndexedDB.
- **`src/starters/` is data, not behaviour.** An Architecture Starter declares nodes, edges and
  coordinates; `build.ts` derives every connector's semantics from `connectorSemantics.ts`'s matrix
  rather than stating them, and nothing in the module sets a colour, font or personality. A starter
  that hardcoded either would silently drift from the rest of the app — one on the next matrix
  change, the other on the next theme. Everything it creates is an ordinary node/edge; there is no
  "starter" marker anywhere in the document.
- **A command palette entry is a name for an existing store action, never a new way to change
  the document.** Every command in `src/commands/registry.ts` calls `useEditorStore`/`useUiStore`
  (or a React Flow camera method) — never `src/document/operations.ts` directly, and never its
  own document logic. If a command needs an operation that doesn't exist, add the operation and
  a store wrapper first (the way `reverseEdge` was added), then name it. Commands live only in
  `registry.ts` (and `search.ts` for jump targets); nothing else may build one ad hoc.
- **Learn content is data.** A recipe is an entry in `src/learn/recipes.ts` plus a scene in
  `src/learn/scenes/` (the compiler insists on the pair); `src/learn/` stays free of React so the
  palette can list recipe titles without loading Learn, and everything that draws lives in `src/ui/learn/`, loaded only when Learn
  opens. Every label a recipe names must be a label the product actually shows.
- **`version` is read only in `src/document/migrate.ts`.** Nothing else may branch on it. Since v12 a
  document is a *tree* of graphs (a node may own the architecture inside it), so a migration that
  touches nodes, edges or flows has to reach every room: write it against one graph and wrap it in
  `everyRoom` in the `MIGRATIONS` table. `migrate.test.ts` builds an old file carrying the data each
  of those migrations exists to rewrite at all four levels and insists every level came through, so
  forgetting is a failing test rather than a silently half-migrated file.
- **A root-only document field has to be named in `depth/tree.ts`'s `embed`.** `viewOf` hands a
  room every root-level field through a spread, so `DraftDocument.actions` (and `settings`, and
  `metadata`) is readable inside a room for free — and is dropped on the way back out unless
  `embed` carries it home too. The failure is silent and only shows up as "the action I captured
  while inside that service is gone." Anything added beside them needs a line in `embed`, in
  `shallowEqualDocument` (`store/editorStore.ts`) and in `sameContent` (`history/HistoryStack.ts`);
  miss the second and every edit to it is discarded as a no-op, miss the third and a typed-then-
  erased burst leaves a dead undo step.
- **A room is reached only through `src/depth/tree.ts` and the store's lens.** `editorStore`'s
  `document` is the room being edited (the whole file at the top, by identity); `fileOf` reassembles
  the file, and only the handful of places that persist or export a *file* — autosave, the VS Code
  host, `.draftcanvas` export, conflict resolution, the document-wide limits — may call it.
  Everything else keeps treating `document` as the whole diagram, which is what stops depth from
  becoming a conditional in every component. A room exists exactly when it holds at least one
  shape: `embed` enforces that on write and `validate.ts` on read, so an empty room is never saved
  and "create a view" is never a step the user has to take.
- **No side effects inside React state updaters.** React runs them twice in development; doing
  this recorded every drag twice and made undo appear broken.
- **Handles must render in every mode**, including presentation. React Flow resolves edge
  endpoints through them, so hiding them deletes every connector.
- `nodeTypes` / `edgeTypes` must stay module-scope constants, or React Flow remounts every node
  on every render.
- **A store selector must return a stable reference.** zustand 5 re-reads a selector to check it, so
  one that can hand back a fresh array or object (a `.filter()` that dropped only *some* of its
  input, a spread, a `new Set`) is an infinite render loop that takes the whole canvas down — and it
  only shows when the input is partly filtered, which is why one shipped. Wrap any selector that
  can return a new collection in `useShallow`, as `DraftEdgeView.tsx`'s `obstacles` and `crossings` do.
- **Nothing per node or per edge may do real work on every store update.** A selector subscribed by
  every connector runs (connectors × store updates) times — every frame of a pan, every click — so
  React Flow's own `<EdgeLabelRenderer>`, which does a `querySelector` in one, was three quarters of
  all main-thread time on a large diagram. Use `src/canvas/EdgeLabels.tsx` (one lookup, shared through
  context) rather than the library component, and treat any new per-element `useStore` selector that
  touches the DOM, allocates, or scans as a bug.
- **Nothing a node does on mount may update React Flow's store.** The converse of the rule above: a
  store update costs every subscriber, so one per node is quadratic. `DraftNodeView`'s
  `updateNodeInternals(id)` ran on mount as well as on resize, and opening 1,000 shapes froze for
  9 s. React Flow measures new nodes itself, in one batch; re-measure only on a real size change.
- **A handle nobody can see stays `visibility: hidden`, not just transparent.** Every handle is
  positioned, so each is a layer the browser visits on every hit test — every pointer move and
  click — and twelve a shape made that 3–4 ms a test at 500 shapes. Hidden, it is skipped and still
  laid out, so React Flow still measures it. Anything new that reveals handles sets `visibility:
  visible` beside `opacity: 1` (`canvas.css`); `display: none` would delete every connector.
- **A memoized plan must not close over its scratch work.** Undo history keeps a snapshot per step,
  and each snapshot keeps its `routingPlan` / `crossingPlan` alive. V8 gives every closure made in
  a function one shared scope, so a lookup built *inside* the planner (`crossingsFor: (id) =>
  result.get(id)`) quietly keeps the planner's segment grid and hash alive with it — over a
  megabyte per step at Large, all of it dead the moment the function returned. Build the returned
  object in a module-level function, as `planOf` in `crossings.ts` does.
- **Edges are the one exception to "one renderer."** Unlike nodes, `src/canvas/DraftEdgeView.tsx`
  (on-screen) and `src/edges/describe.ts` (SVG export) are two independent implementations of the
  same connector. A visual addition to a connector — a badge, a dash pattern, a chip — must be
  made in both, by hand; nothing enforces parity. See `docs/reference/architecture.md`. (Intent
  Continuation's ghost connector in `src/canvas/ContinuationGhost.tsx` is a preview, never
  exported, and reuses the routing/dash/marker helpers rather than restating them — it is exempt.)

## Architecture

Dependencies point one way: `ui/` → `canvas/` → `document/`, with `storage/` and `export/`
hanging off the document model. Library and editor are two states of one screen (`src/App.tsx`,
no router) — that's what lets `dist/` be served from any path (`base: './'`).

`www/` is the landing page at <https://acltabontabon.com/draft-canvas/> — a separate Vite project with
its own lockfile and no dependency in common with the app, which is what keeps a marketing stylesheet
out of the editor and a `fetch` out of `src/`. The editor deploys by copying `dist/` into
`dist-web/editor/` unchanged; `vite.config.ts` knows nothing about any of it, and must not.
`tests/site-isolation.test.ts` fails if either of those stops being true, and
[`docs/reference/website.md`](docs/reference/website.md) explains how the editor's move off
`/draft-canvas/` was made safe for saved diagrams, released VS Code extensions and the old service
worker.

`src/starters/` sits beside `document/` (it imports only that, and is not part of the file format);
`store/` and `commands/` consume it. `src/continuation/` sits there too (it imports `document/` and
`render/text` only) — the deterministic next-move rules; `store/`, `commands/` and `canvas/` consume it.
`src/takeaways/` sits beside them too (it imports `document/` and `depth/` only) — what the
discussion produced, derived from the notes already on the canvas plus the document's own
`actions`; `commands/` and `ui/` consume it. `src/depth/` sits there as well (it imports `document/` only) — the tree of rooms inside shapes and
the view levels they show; `store/`, `commands/`, `canvas/`, `history/`, `storage/` and `ui/` consume it. The reasoning behind every module boundary — one renderer, the canvas/store boundary, history,
persistence, the crypto boundary, untrusted input, schema evolution — lives in
[`docs/reference/architecture.md`](docs/reference/architecture.md). The rules above are the invariants that document
distills into "never break this"; read that file for *why* each one holds.

## Conventions

npm. 2-space indent, single quotes, semicolons, trailing commas. oxlint, no prettier. TypeScript
solution config with project references (`tsconfig.app.json` covers `src` with browser types only;
`tsconfig.test.json` adds `tests` with the Vitest and Node globals, so neither can leak into app code). Vitest for
unit tests, Playwright for the journey.

Comments explain *why*, not *what*. Several of the ones in `Canvas.tsx`, `autosave.ts`,
`useDocumentSession.ts` and `vite.config.ts` record bugs found the hard way — leave them there.

## Documentation

Start at [`docs/index.md`](docs/index.md). Guides for people using the app live in `docs/guides/`;
design and reference material lives in `docs/reference/`:

- `docs/reference/architecture.md` — the design principles and the reasoning behind every boundary
- `docs/reference/semantics.md` — the connector capability matrix (a test keeps its rules table in step with the code)
- `docs/reference/schema.md` — schema version history and the migration/import-validation contract
- `docs/reference/privacy.md` — what is stored, where, and what leaves the machine
- `docs/reference/performance.md` — benchmark methodology and the published results
- `docs/reference/website.md` — the landing page, and how Pages is built and deployed
- `docs/reference/desktop-updates.md` — the desktop updater's signing key and release checks
- `SECURITY.md` — threat model and key lifecycle
- `CHANGELOG.md` — user-facing release notes

Docs files are lowercase kebab-case; the conventional root files (`README.md`, `CONTRIBUTING.md`,
`SECURITY.md`, …) keep their usual names. The performance tables in `README.md` and
`docs/reference/performance.md` are generated (`npm run perf:publish`) — edit the prose around the
markers, not what sits between them. `tests/docs.test.ts` fails on a broken relative link or anchor,
and `npx tsx e2e/docs-screenshots.ts` regenerates the guides' screenshots from the real UI.
