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
- **Never add a network call in `src/`.** `tests/privacy.test.ts` fails the build on `fetch`,
  `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`, `eval`, or `new Function` anywhere
  in the app's own code. The production CSP (injected by a Vite plugin in `vite.config.ts`) sets
  `connect-src 'self'` — no request to any other origin is possible. The one legitimate
  same-origin exception is the offline Service Worker (`vite-plugin-pwa`), which fetches
  the app's own assets and checks for updates in the background; it never touches IndexedDB or
  canvas content. No webfonts either — an SVG rasterized through `<canvas>` cannot resolve them,
  so every PNG would export in the wrong typeface.
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
  made in both, by hand; nothing enforces parity. See `docs/ARCHITECTURE.md`. (Intent
  Continuation's ghost connector in `src/canvas/ContinuationGhost.tsx` is a preview, never
  exported, and reuses the routing/dash/marker helpers rather than restating them — it is exempt.)

## Architecture

Dependencies point one way: `ui/` → `canvas/` → `document/`, with `storage/` and `export/`
hanging off the document model. Library and editor are two states of one screen (`src/App.tsx`,
no router) — that's what lets `dist/` be served from any path (`base: './'`).

`src/starters/` sits beside `document/` (it imports only that, and is not part of the file format);
`store/` and `commands/` consume it. `src/continuation/` sits there too (it imports `document/` and
`render/text` only) — the deterministic next-move rules; `store/`, `commands/` and `canvas/` consume it. The reasoning behind every module boundary — one renderer, the canvas/store boundary, history,
persistence, the crypto boundary, untrusted input, schema evolution — lives in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). The rules above are the invariants that document
distills into "never break this"; read that file for *why* each one holds.

## Conventions

npm. 2-space indent, single quotes, semicolons, trailing commas. oxlint, no prettier. TypeScript
solution config with project references (`tsconfig.app.json` covers `src` and `tests`). Vitest for
unit tests, Playwright for the journey.

Comments explain *why*, not *what*. Several of the ones in `Canvas.tsx`, `autosave.ts`,
`useDocumentSession.ts` and `vite.config.ts` record bugs found the hard way — leave them there.

## Documentation

`docs/ARCHITECTURE.md` (the reasoning behind every boundary, plus the `.draftcanvas` format and
flows/presentation) · `docs/SEMANTICS.md` (the connector capability matrix) ·
`docs/SCHEMA.md` (schema version history and the migration/import-validation contract) ·
`docs/PRIVACY.md` · `SECURITY.md` (threat model and key lifecycle) ·
`CHANGELOG.md` (user-facing release notes)
