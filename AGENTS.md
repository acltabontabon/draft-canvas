# Draft Canvas — working notes

Draft Canvas is a local-first React + TypeScript SPA (Vite) for explaining software visually.
No backend, no accounts, no network calls.

## Commands

```bash
npm run dev        # dev server on :5180
npm run build      # tsc -b && vite build
npm run lint       # oxlint
npm test           # vitest run
npm run e2e        # playwright (npm run e2e:install once first)
npm run check      # lint + build + unit tests — run this before calling work done
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
- **Never add a network call.** `tests/privacy.test.ts` fails the build on `fetch`,
  `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`, `eval`, or `new Function`. The
  production CSP (injected by a Vite plugin in `vite.config.ts`) sets `connect-src 'none'`.
  No webfonts either — an SVG rasterized through `<canvas>` cannot resolve them, so every PNG
  would export in the wrong typeface.
- **`localStorage` is only for tiny preferences**, and only through `src/lib/preferences.ts`.
  Documents go in IndexedDB.
- **`version` is read only in `src/document/migrate.ts`.** Nothing else may branch on it.
- **No side effects inside React state updaters.** React runs them twice in development; doing
  this recorded every drag twice and made undo appear broken.
- **Handles must render in every mode**, including presentation. React Flow resolves edge
  endpoints through them, so hiding them deletes every connector.
- `nodeTypes` / `edgeTypes` must stay module-scope constants, or React Flow remounts every node
  on every render.
- **Edges are the one exception to "one renderer."** Unlike nodes, `src/canvas/DraftEdgeView.tsx`
  (on-screen) and `src/edges/describe.ts` (SVG export) are two independent implementations of the
  same connector. A visual addition to a connector — a badge, a dash pattern, a chip — must be
  made in both, by hand; nothing enforces parity. See `docs/ARCHITECTURE.md`.

## Architecture

Dependencies point one way: `ui/` → `canvas/` → `document/`, with `storage/` and `export/`
hanging off the document model.

**One renderer.** `nodes/describe.ts` turns a node into a display list (pure); `render/svg/emit.ts`
turns that into an SVG element tree; `render/svg/element.ts` serializes it. The canvas paints that
string and the exporter writes it to a file — so an export is pixel-identical to the screen.
Interactive chrome (handles, resize frames, selection rings, inline editors) lives in React/CSS
precisely so it can never appear in an exported image. Node visuals go through
`dangerouslySetInnerHTML` with markup from our own escaping serializer.

**Canvas boundary.** The zustand store (`store/editorStore.ts`) owns the `DraftDocument`; React
Flow is a controlled view. `canvas/projection.ts` derives React Flow's arrays during render and
preserves object identity for unchanged nodes. `node.data` carries only `{ id }` — node components
subscribe to the store themselves. **The document is not written during a drag**: positions stream
to the rendered nodes for smoothness, and the document is updated only when the gesture ends, so
one drag is one undo entry.

**History** (`history/HistoryStack.ts`) is snapshot-based with structural sharing — operations in
`document/operations.ts` return new documents reusing untouched nodes.
`beginInteraction`/`endInteraction` bracket a gesture; entries sharing a `coalesceKey` merge.
Viewport changes are persisted but never recorded.

**Persistence.** Two IndexedDB stores: `documents` (summaries) and `bodies` (full documents), so
the library screen lists titles without deserializing any canvas. Autosave debounces 700 ms with a
4 s ceiling and flushes on `visibilitychange`/`pagehide` (never `beforeunload` — it kills bfcache).
IndexedDB failure falls back to `MemoryRepository` and the UI says so.

**Untrusted input.** `document/validate.ts` is the only door into the model, for both imported
files and records read back from IndexedDB. Policy is **repair, don't reject**. Colour is an enum,
never a user string reaching an SVG `fill`.

**No router.** Library and editor are two states of one screen (`src/App.tsx`), which is what lets
`dist/` be served from any path (`base: './'`).

## Conventions

npm. 2-space indent, single quotes, semicolons, trailing commas. oxlint, no prettier. TypeScript
solution config with project references (`tsconfig.app.json` covers `src` and `tests`). Vitest for
unit tests, Playwright for the journey.

Comments explain *why*, not *what*. Several of the ones in `Canvas.tsx`, `autosave.ts`,
`useDocumentSession.ts` and `vite.config.ts` record bugs found the hard way — leave them there.

## Documentation

`docs/ARCHITECTURE.md` (the reasoning behind every boundary) · `docs/SCHEMA.md` (the
`.draftcanvas` format) · `docs/FLOWS.md` (flows and presentation mode) · `docs/PRIVACY.md` ·
`SECURITY.md` (threat model and key lifecycle) · `docs/ROADMAP.md` (numbered phases, shipped
through planned) · `CHANGELOG.md` (user-facing release notes)
