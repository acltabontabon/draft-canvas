# Draft Canvas — working notes

A local-first canvas for developers to explain software visually. React + TypeScript SPA built
by Vite. No backend, no accounts, no network calls.

## Commands

```bash
npm run dev        # dev server on :5180
npm run build      # tsc -b && vite build
npm run lint       # oxlint
npm test           # vitest run
npm run e2e        # playwright (npm run e2e:install once first)
npm run check      # lint + build + unit tests
```

## Rules that are load-bearing

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
  production CSP sets `connect-src 'none'`.
- **`localStorage` is only for tiny preferences**, and only through `src/lib/preferences.ts`.
  Documents go in IndexedDB.
- **`version` is read only in `src/document/migrate.ts`.** Nothing else may branch on it.
- **No side effects inside React state updaters.** React runs them twice in development; doing
  this recorded every drag twice in history and made undo appear broken.
- **Handles must render in every mode**, including presentation. React Flow resolves edge
  endpoints through them, so hiding them deletes every connector.
- `nodeTypes` / `edgeTypes` must stay module-scope constants, or React Flow remounts every node
  on every render.
- **Edges are the one exception to "one renderer."** `src/canvas/DraftEdgeView.tsx` (on-screen)
  and `src/edges/describe.ts` (SVG export) are two independent implementations of the same
  connector. A visual addition to a connector must be made in both, by hand.

## Conventions

npm. 2-space indent, single quotes, semicolons, trailing commas. oxlint, no prettier. TypeScript
solution config with project references. Vitest for unit tests, Playwright for the journey.

Comments explain *why*, not *what*. Several of the ones in `Canvas.tsx` and `autosave.ts` record
bugs that were found the hard way — leave them there.

## Documentation

`docs/ARCHITECTURE.md` · `docs/SCHEMA.md` · `docs/FLOWS.md` · `docs/PRIVACY.md` · `SECURITY.md`
