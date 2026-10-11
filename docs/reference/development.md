# Development reference

Start with [Contributing](../../CONTRIBUTING.md) for setup and the verification rules.
This reference covers commands, repository structure, host wiring and specialized checks.
For the design rationale, see [Architecture](architecture.md).

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` | Type-check and produce a production build in `dist/` |
| `npm run lint` | oxlint |
| `npm test` | Unit and integration tests (Vitest) |
| `npm run test:watch` | Vitest in watch mode |
| `npm run e2e` | Browser tests (Playwright — run `npm run e2e:install` once first) |
| `npm run e2e:offline` | The offline test against a built, offline-served app |
| `npm run check` | Lint, tooling type-check, build and unit tests — run for code changes |
| `npm run check:full` | All local checks and browser suites — optional; full browser coverage runs in CI |
| `npm run site:dev` | The landing page (`www/`) alone, on :5280 |
| `npm run build:web` | The editor and the landing page, assembled into `dist-web/` as Pages serves them |
| `npm run e2e:web` | Browser tests against that assembled build, served under `/draft-canvas/` |
| `npm run desktop:dev` | The desktop app (`src-tauri/`) with hot reload |
| `npm run desktop:build` | An installer for the desktop app |
| `npm run desktop:check` | The desktop build, the Rust checks (`fmt`, `clippy`, `test`) and the version check |
| `npm run e2e:desktop` | The desktop screens in the browser, against a faked shell. No Rust needed |

Focused runs, when you're iterating on one thing:

```bash
npx vitest run tests/history.test.ts    # one unit test file
npx vitest run -t 'coalesces'           # by test name
PLAYWRIGHT_BROWSER=chromium npx playwright test e2e/editing.spec.ts # one browser, one spec
```

For a Firefox failure, run just the failing test and repeat it without retries. Keep a trace on
failure so the next investigation starts with the actual interaction, not another full suite:

```bash
PLAYWRIGHT_BROWSER=firefox npx playwright test e2e/look-inside.spec.ts \
  -g 'the depth map opens' --repeat-each=10 --retries=0 --trace=retain-on-failure
npx playwright test --project=firefox --last-failed --trace=retain-on-failure
npx playwright show-trace 'test-results/<failed-test>/trace.zip'
```

The main suite uses Vite's dev server because some specs import the running app's source modules.
Its setup opens About and the editor before testing to pay lazy compilation costs outside the first
test's clock. Offline and deployment tests use the production build. CI runs the main suite once
per browser in Chromium, Firefox and WebKit.
CI treats a test that passes only on retry as a failure; fix the underlying race with a wait for the
state the next action needs (focus, a settled camera, or a finished drag), rather than a fixed sleep.

## Repository map

The editor lives in `src/`; platform shells and tooling live beside it.

| Path | What's there |
| --- | --- |
| `src/` | The editor: React + TypeScript, built by Vite. Every distribution runs this code |
| `src/desktop/` | The desktop app's screens and logic (Home, Browse, updates, settings), compiled out of the web build |
| `src-tauri/` | The desktop app's native side in Rust (Tauri 2): windows, tray, dialogs, file I/O, updater |
| `src-tauri/mcp/` | `draft-canvas-mcp`, the MCP connector an AI agent launches; bundled inside the desktop app ([Agent integration](agent-integration.md)) |
| `www/` | The landing page at <https://acltabontabon.com/draft-canvas/>: a separate Vite project sharing no dependency with the app ([The website](website.md)) |
| `tests/` | Vitest unit and integration tests; `tests/desktop/` for the desktop controller |
| `e2e/` | Playwright specs; `e2e/desktop/` runs the desktop screens against a mock shell |
| `benchmark/` | The performance harness behind `npm run perf*` ([Performance](performance.md)) |
| `scripts/` | Build and release scripts: changelog parsing, release notes, the update manifest, web assembly |
| `docs/` | Guides for people using the app, and reference material for people changing it ([index](../index.md)) |
| `public/` | Static files copied into the editor's build as-is |

At the root, besides the usual manifests and tool configs:

- `index.html` is the editor's entry page.
- `Dockerfile` and `nginx.conf` build the Docker image: the web build served by nginx.
- Four Playwright configs, one per target: `playwright.config.ts` (the dev server), `playwright.dist.config.ts`
  (the built app, offline), `playwright.web.config.ts` (the assembled Pages build) and
  `playwright.desktop.config.ts` (the desktop build against a faked shell).
- [`AGENTS.md`](../../AGENTS.md) holds the load-bearing rules, written for coding agents and people alike.

The demo reel in `docs/media/` is recorded with a harness that isn't part of the repository; the
`demo/` entries in the lint and type-check configs are for that local copy and do nothing without it.

## How it fits together

Enough to find the right file for a first change. The reasoning behind each boundary is in
[Architecture](architecture.md), and the rules that must not break are in
[`AGENTS.md`](../../AGENTS.md).

**Layers.** `src/document/` is the file format and every operation on it, with no React. `src/store/`
(zustand) holds the open document and wraps those operations for the UI. `src/canvas/` draws it with
React Flow, and `src/ui/` is everything around the canvas. What a shape looks like is described once,
in `src/nodes/describe.ts` and `src/render/`, for both the screen and every export. Features that
reason about a diagram — suggestions (`src/continuation/`), shapes inside shapes (`src/depth/`),
starters (`src/starters/`) — import only `document/`. AI agents' requests (desktop only) are validated,
laid out and checked in `src/agent/`, with the layout itself in `src/layout/`; neither imports React.

**Entry points.** `index.html` → `src/main.tsx` → `src/App.tsx`, which has no router: it shows the
Library (web), Home (desktop), or the editor once a document is open. The desktop app starts with
`src/desktop/boot.ts`.

**One editor, two hosts.** Shared code doesn't branch on the platform itself; a few seams do:

- `__DESKTOP__` is a build-time constant (`vite build --mode desktop`), so desktop-only code is
  compiled out of the web build.
- `hostKind()` in `src/host/hostInfo.ts` says, at run time, whether a host owns the file: the desktop
  app, or nobody (the web app owns its own documents).
- `getRepository()` in `src/storage/index.ts` picks where documents live, and `setFileSaver()` in
  `src/export/download.ts` picks how an export is saved.
- Only `src/desktop/tauri/` may import `@tauri-apps/*`; `tests/privacy.test.ts` enforces it.

**Where a diagram is saved:**

| Platform | Path |
| --- | --- |
| Web | `store/useDocumentSession.ts` → `storage/autosave.ts` → `IndexedDbRepository` (plain records; `src/crypto/` reads the rows earlier builds encrypted) |
| Desktop | `host/useHostDocument.ts` → `desktop/controller.ts` → `desktop/tauri/api.ts` → Rust `src-tauri/src/commands/documents.rs` and `docio.rs` |

Everything that comes in — a file opened, imported or handed over by a host, a paste, a document
read back from IndexedDB — goes through `parseDocument` in `src/document/validate.ts`, which migrates
old versions (`src/document/migrate.ts`) and repairs or rejects what it can't trust, before it
reaches the canvas. Files arrive through `src/export/project.ts`.

## Platform checks

For code changes, add the relevant checks below. Browser checks are focused local runs when needed;
full suites run in CI.

| You changed | Additional checks |
| --- | --- |
| The editor (`src/`) | Relevant editor browser specs when needed |
| Desktop (`src/desktop/`, `src-tauri/`) | `npm run desktop:check`; relevant desktop browser specs when needed |
| AI agent support (`src/agent/`, `src/layout/`, native agent or MCP code) | Relevant desktop checks; `npm run agent:schemas` if schemas changed; preview the agent gallery if layout changed |
| The landing page (`www/`) or `scripts/assemble-web.mjs` | `npm run build:web`; relevant web deployment specs when needed |
| `Dockerfile`, `nginx.conf` | `docker build .`, then run the image and open it |
| Offline behavior or the service worker | Relevant offline browser specs when needed |

Changes to the editor don't need Rust. `desktop:check` builds the desktop web bundle first, which the
Rust checks need; `npm run desktop:rust` on its own fails on a fresh checkout.

## UI changes

Verify in the browser, not just in your head — both themes (light/dark), and if it touches
Presentation Mode or the Intentional Roughness presets, check those too. Keyboard reachability
matters: most of Draft Canvas is designed to be usable without a mouse. Above all, keep it fast —
the product's whole reason for existing is that opening it should feel closer to grabbing a marker
than opening a modeling tool. If a change makes the common path slower or busier to look at, that's
a real cost, not a style nitpick.

## Architecture-semantic changes

This is the part of Draft Canvas most worth getting right, and the part where "looks nice" isn't a
strong enough reason on its own. Before adding or changing a rule in
`src/document/connectorSemantics.ts`'s capability matrix (see
[`docs/reference/semantics.md`](semantics.md) for what's there today):

> When adding architecture-aware behavior, optimize for technical correctness and developer
> intuition. Draft Canvas should be opinionated where the underlying technology is opinionated, and
> permissive where multiple architectures are valid.

Concretely:

- A new rule should be technically defensible — grounded in how the technology actually works
  (a queue really doesn't publish into a topic), not just a relationship that would look tidier.
- Guide, never block. The matrix's job is to narrow and nudge (a sensible default, an optional
  "this looks unusual" note), never to reject a connection the user drew on purpose.
- If a pairing is genuinely ambiguous, leave it unopinionated rather than guessing — an absent
  matrix entry falls back to full, unrestricted freedom, and that's a legitimate outcome, not a gap
  to fill reflexively.
- Don't add a feature — semantic or otherwise — merely because another diagramming tool has it.
  Draft Canvas is deliberately not draw.io, Lucidchart, or a UML/BPMN tool.

## Documentation

Start at [`docs/index.md`](../index.md). Guides for people using the app are in `docs/guides/`;
design and reference material is in `docs/reference/`. Docs files are lowercase kebab-case.

- **Change behavior, change the guide.** If a change alters a control, a shortcut, or what happens to a
  diagram, update the guide that describes it. The shortcut sheet (`shortcutSections.ts`) reads the
  command registry, so a new key needs a row there too. Don't document something as available before
  it ships.
- **Screenshots** in the guides are generated by driving the real app:
  `npx tsx e2e/docs-screenshots.ts` rewrites `docs/media/guides/*.png`. Re-run it when a UI change
  makes one stale. If a step in a guide stops working, the script fails there.
- **Performance numbers** live in `docs/reference/performance.md`, generated by `npm run perf:publish`
  between its markers. Edit the prose around them, not the tables.
- CI checks documentation links through `tests/docs.test.ts`. For docs-only changes, inspect links
  and formatting directly; no local test run is required.

## Keeping Draft Canvas fast and simple

The whole product bets on staying lightweight. A dependency, a setting, or a new concept all cost
something — read [`docs/reference/architecture.md`](architecture.md)'s "Deliberately not built" before
proposing something in that direction (accounts, cloud sync, collaboration, AI generation, icon
packs, and a few others are deliberately out of scope). If you're unsure whether an idea fits, open
an issue and ask — that's exactly what issues are for.
