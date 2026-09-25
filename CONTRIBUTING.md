# Contributing to Draft Canvas

Thanks for taking a look. Draft Canvas is a small, opinionated tool, and this doc is meant to keep
it that way — quick to read, quick to act on.

## Running it locally

You need **Node 22.14 or later** (CI runs 22.14.0) and **npm** — not yarn or pnpm; the lockfiles are
npm's. No backend, no environment variables, no accounts to set up:

```bash
git clone https://github.com/acltabontabon/draft-canvas.git
cd draft-canvas
npm install
npm run dev        # http://localhost:5180
```

That's everything the editor needs. Two parts need more, and only when you work on them:

- **The desktop app** needs the [Rust toolchain](https://www.rust-lang.org/tools/install) (stable; the
  minimum is `rust-version` in `src-tauri/Cargo.toml`) and Tauri's
  [system prerequisites](https://v2.tauri.app/start/prerequisites/) — see
  [Building it yourself](docs/guides/desktop.md#building-it-yourself).
- **The landing page** (`www/`) and **the VS Code extension** (`vscode-extension/`) each have their own
  `package.json` and lockfile: `npm ci` inside the folder once.

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
| `npm run check` | Lint, type-check the e2e/benchmark tooling, build, and unit tests together — **run this before opening a PR** |
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
npx playwright test e2e/editing.spec.ts # one e2e spec
```

## Repository map

One editor, shipped four ways. Almost everything lives in `src/`; each other top-level folder is
either one distribution's own shell or tooling around the editor.

| Path | What's there |
| --- | --- |
| `src/` | The editor: React + TypeScript, built by Vite. Every distribution runs this code |
| `src/desktop/` | The desktop app's screens and logic (Home, Browse, updates, the tray panel), compiled out of the web build |
| `src-tauri/` | The desktop app's native side in Rust (Tauri 2): windows, tray, dialogs, file I/O, updater |
| `src-tauri/mcp/` | `draft-canvas-mcp`, the MCP connector an AI agent launches; bundled inside the desktop app ([Agent integration](docs/reference/agent-integration.md)) |
| `vscode-extension/` | Draft Canvas for VS Code: one source file that frames the hosted editor. Own version, changelog and [release process](vscode-extension/RELEASING.md) |
| `www/` | The landing page at <https://acltabontabon.com/draft-canvas/>: a separate Vite project sharing no dependency with the app ([The website](docs/reference/website.md)) |
| `tests/` | Vitest unit and integration tests; `tests/desktop/` for the desktop controller |
| `e2e/` | Playwright specs; `e2e/desktop/` runs the desktop screens against a mock shell |
| `benchmark/` | The performance harness behind `npm run perf*` ([Performance](docs/reference/performance.md)) |
| `scripts/` | Build and release scripts: changelog parsing, release notes, the update manifest, web assembly |
| `docs/` | Guides for people using the app, and reference material for people changing it ([index](docs/index.md)) |
| `public/` | Static files copied into the editor's build as-is |

At the root, besides the usual manifests and tool configs:

- `index.html` is the editor's entry page, and `tray.html` the desktop tray panel's (a desktop build input only).
- `Dockerfile` and `nginx.conf` build the Docker image: the web build served by nginx.
- Four Playwright configs, one per target: `playwright.config.ts` (the dev server), `playwright.dist.config.ts`
  (the built app, offline), `playwright.web.config.ts` (the assembled Pages build) and
  `playwright.desktop.config.ts` (the desktop build against a faked shell).
- [`AGENTS.md`](AGENTS.md) holds the load-bearing rules, written for coding agents and people alike.

The demo reel in `docs/media/` is recorded with a harness that isn't part of the repository; the
`demo/` entries in the lint and type-check configs are for that local copy and do nothing without it.

## How it fits together

Enough to find the right file for a first change. The reasoning behind each boundary is in
[Architecture](docs/reference/architecture.md), and the rules that must not break are in
[`AGENTS.md`](AGENTS.md).

**Layers.** `src/document/` is the file format and every operation on it, with no React. `src/store/`
(zustand) holds the open document and wraps those operations for the UI. `src/canvas/` draws it with
React Flow, and `src/ui/` is everything around the canvas. What a shape looks like is described once,
in `src/nodes/describe.ts` and `src/render/`, for both the screen and every export. Features that
reason about a diagram — suggestions (`src/continuation/`), shapes inside shapes (`src/depth/`),
starters (`src/starters/`) — import only `document/`. AI agents' requests (desktop only) are validated,
laid out and checked in `src/agent/`, with the layout itself in `src/layout/`; neither imports React.

**Entry points.** `index.html` → `src/main.tsx` → `src/App.tsx`, which has no router: it shows the
Library (web), Home (desktop), or the editor once a document is open. The desktop app starts with
`src/desktop/boot.ts`; the VS Code extension's side is `vscode-extension/src/extension.ts`.

**One editor, three hosts.** Shared code doesn't branch on the platform itself; a few seams do:

- `__DESKTOP__` is a build-time constant (`vite build --mode desktop`), so desktop-only code is
  compiled out of the web build.
- `hostKind()` in `src/host/hostInfo.ts` says, at run time, whether a host owns the file: VS Code
  (the app is framed with `?host=vscode`) or the desktop app.
- `getRepository()` in `src/storage/index.ts` picks where documents live, and `setFileSaver()` in
  `src/export/download.ts` picks how an export is saved.
- Only `src/desktop/tauri/` may import `@tauri-apps/*`; `tests/privacy.test.ts` enforces it.

**Where a diagram is saved:**

| Platform | Path |
| --- | --- |
| Web | `store/useDocumentSession.ts` → `storage/autosave.ts` → `IndexedDbRepository`, encrypting bodies with `src/crypto/` |
| Desktop | `host/useHostDocument.ts` → `desktop/controller.ts` → `desktop/tauri/api.ts` → Rust `src-tauri/src/commands/documents.rs` and `docio.rs` |
| VS Code | `host/useHostDocument.ts` + `host/vscodeChannel.ts` ⇄ `vscode-extension/src/extension.ts`, which writes the file through VS Code |

Everything that comes in — a file opened, imported or handed over by a host, a paste, a document
read back from IndexedDB — goes through `parseDocument` in `src/document/validate.ts`, which migrates
old versions (`src/document/migrate.ts`) and repairs or rejects what it can't trust, before it
reaches the canvas. Files arrive through `src/export/project.ts`.

## Which checks for which change

`npm run check` is for every PR. Add the rows that match what you touched; CI runs all of them.

| You changed | Also run |
| --- | --- |
| The editor (`src/`) | `npm run e2e` |
| Anything only the desktop app uses (`src/desktop/`, `src-tauri/`, `tray.html`) | `npm run desktop:check` and `npm run e2e:desktop` |
| AI agent support (`src/agent/`, `src/layout/`, `src-tauri/src/agent/`, `src-tauri/mcp/`) | The above, plus `npm run agent:schemas` if `src/agent/schema.ts` changed, and `npx tsx e2e/agent-gallery.ts --base <dev server> --out <dir>` to look at the layout gallery in both themes |
| The landing page (`www/`) or `scripts/assemble-web.mjs` | `npm run e2e:web` |
| The VS Code extension | In `vscode-extension/`: `npm run compile`, `npx vsce package`, `npm run check:vsix -- <file>.vsix`, and `npm run smoke -- <file>.vsix` (it downloads VS Code) |
| `Dockerfile`, `nginx.conf` | `docker build .`, then run the image and open it |
| Offline behaviour or the service worker | `npm run e2e:offline` |

Changes to the editor don't need Rust. `desktop:check` builds the desktop web bundle first, which the
Rust checks need; `npm run desktop:rust` on its own fails on a fresh checkout.

## Conventions

npm (not yarn/pnpm), 2-space indent, single quotes, semicolons, trailing commas. oxlint, no
Prettier. TypeScript with project references. Comments explain *why*, not *what* — several existing
ones record a bug found the hard way; don't remove those. See [`AGENTS.md`](AGENTS.md) for the
fuller set of load-bearing rules (where node appearance lives, why text is only ever wrapped once,
why `src/document/` can't import React, and so on) before touching core rendering, storage, or the
document model.

## Reporting a bug, proposing a change

- **Bugs:** [open a bug report](https://github.com/acltabontabon/draft-canvas/issues/new/choose). Say
  where you ran it (web, Docker, desktop, VS Code, or from source) and which version (About, or the
  Extensions view for VS Code), with steps that reproduce it — ideally on a fresh canvas. A
  `.draftcanvas` file that shows the problem is the most useful attachment there is, once you've
  checked it holds nothing private.
- **Ideas:** open a feature request that starts from the problem, not the solution.
- **Security:** never in a public issue — see [`SECURITY.md`](SECURITY.md).

## Submitting a change

1. Fork, branch, make your change.
2. `npm run check`, plus the rows above that apply — fix anything they catch. Don't work around a
   real failure to get green output.
3. If people using Draft Canvas would notice the change, add a line to `CHANGELOG.md` (see
   [Release notes](#release-notes)).
4. Open a PR against `main` with what changed and why. Small, focused PRs are easier to review than
   one PR doing three things.
5. **Discuss anything large before writing it.** If a change touches the document schema, the
   relationship model, or adds a new node/connector concept, open an issue first. It's a much
   cheaper conversation before the code exists than after.

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
[`docs/reference/semantics.md`](docs/reference/semantics.md) for what's there today):

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

Start at [`docs/index.md`](docs/index.md). Guides for people using the app are in `docs/guides/`;
design and reference material is in `docs/reference/`. Docs files are lowercase kebab-case.

- **Change behavior, change the guide.** If a change alters a control, a shortcut, or what happens to a
  diagram, update the guide that describes it, and the matching Learn recipe in `src/learn/`. Learn
  is the short reminder inside the editor; the guides are the longer walkthroughs. Don't document
  something as available before it ships.
- **Screenshots** in the guides are generated by driving the real app:
  `npx tsx e2e/docs-screenshots.ts` rewrites `docs/media/guides/*.png`. Re-run it when a UI change
  makes one stale. If a step in a guide stops working, the script fails there.
- **Performance numbers** in `README.md` and `docs/reference/performance.md` are generated by
  `npm run perf:publish` between their markers. Edit the prose around them, not the tables.
- `npm test` includes `tests/docs.test.ts`, which fails on a broken relative link or `#anchor` in any
  Markdown file.

## Keeping Draft Canvas fast and simple

The whole product bets on staying lightweight. A dependency, a setting, or a new concept all cost
something — read [`docs/reference/architecture.md`](docs/reference/architecture.md)'s "Deliberately not built" before
proposing something in that direction (accounts, cloud sync, collaboration, AI generation, icon
packs, and a few others are deliberately out of scope). If you're unsure whether an idea fits, open
an issue and ask — that's exactly what issues are for.

## Release notes

Write a user-facing change **once**, in `CHANGELOG.md`. Everything that tells someone what changed is
generated from it, filtered to who it's for:

| Generated | From | Covers |
| --- | --- | --- |
| A `vX.Y.Z` GitHub release (web, Docker and desktop together) | `scripts/release-notes.mjs` | Shared, Desktop and Web — everything since the previous `vX.Y.Z`, prereleases included |
| A `desktop-vX.Y.Z-alpha.N` GitHub prerelease | `scripts/release-notes.mjs` | Shared and Desktop, from that section only |
| The desktop app's "Update available" notes (`latest.json`) | `scripts/update-manifest.mjs` | Shared and Desktop |
| About → What's New in the web build | `vite.config.ts` at build time | Shared and Web highlights |
| About → What's New in the desktop build | `vite.config.ts` at build time | Shared and Desktop highlights |

Nothing fetches notes at runtime, and nothing is written twice: the install steps, downloads and
signing caveats around each release body are fixed templates in `release-notes.mjs`, not changelog text.

### Where a change goes

Under `## [Unreleased]`, in whichever of these fits — leave out any that would be empty:

```markdown
## [Unreleased]

### Shared
- Changes both apps get: the editor, shapes, export, starters, the canvas itself.

### Desktop
- Only the desktop app: files and project folders, Home, Find a Diagram, the menu bar / tray,
  updates, installers and packaging.

### Web
- Only the web app: browser storage and the Library, the offline app, Pages, the Docker image.
```

Decide by where the change actually runs, not where its code lives. Shared source often behaves on
one platform only (a style for a desktop-only screen, say); code under `src/desktop/` or `src-tauri/`
is always Desktop. `####` sub-headings (Added, Fixed, Changed) are fine inside any of the three; any
other `###` heading beside them is an error.

A version may open with one short intro paragraph, which What's New shows as the release's summary.

The VS Code extension keeps its own [`vscode-extension/CHANGELOG.md`](vscode-extension/CHANGELOG.md);
a change to the extension alone goes there instead.

### Highlights for What's New

What's New shows a handful of a release's bullets, not all of them. Mark the ones worth telling
someone using the app by leading with a **bold title** and ending with `<!-- highlight -->`:

```markdown
- **Rename in place** — from Rename File… on the File menu, without leaving Draft Canvas.
  <!-- highlight -->
```

The marker is invisible on GitHub and dropped from every release body. A release's What's New is its
own highlights plus its prereleases'. A desktop preview shows its own entry — it runs its own version
number — until the release it leads to is written, and then folds into it.

What's New for 1.9.4 and earlier is frozen as it was written, in `src/releases/productReleases.ts`
(`ARCHIVED_RELEASES`). Don't add to it.

### Previewing

```bash
npm run release:notes -- desktop-v1.10.0-alpha.2               # what that desktop prerelease said
npm run release:notes -- v1.11.0 --platform web                # one platform's part of a release
npm run release:notes -- vX.Y.Z --draft                        # a release whose section isn't written yet
npm run release:whats-new -- desktop --draft X.Y.Z             # What's New as the desktop build shows it
```

A missing or duplicated version, a heading that isn't a version, mixed headings, or a highlight
without a title fail loudly, naming what to fix; `tests/changelog.test.ts` runs the real changelog
through those rules on every `npm test`. At release time, the desktop half of a `vX.Y.Z` — and every
`desktop-v…` preview — stops without a dated section for its version. The `vX.Y.Z` GitHub release
itself does not: without a section, it is published with GitHub's generated notes instead. So write
the section before tagging.

## Release workflow

For the maintainer. When preparing a release:

1. Keep `CHANGELOG.md`'s `[Unreleased]` section current as you go, in the shape above, marking the
   highlights you'd want in What's New.
2. Before cutting the release, rename `[Unreleased]` to the version with today's date
   (`## [X.Y.Z] - YYYY-MM-DD`), leave a fresh `## [Unreleased]` above it, and preview the notes.
3. At the end of `CHANGELOG.md`, add a `[X.Y.Z]: …/compare/vPREVIOUS...vX.Y.Z` link and move
   `[Unreleased]` to compare from `vX.Y.Z`; `tests/changelog.test.ts` fails until both are there.
4. Bump the version through the normal release process, then ship. Once `package.json`'s version
   reaches that section, About → What's New shows it on its own — no other wiring needed.

Pushing the `vX.Y.Z` tag does the rest: one version, one GitHub Release, everything in it. It creates
the Release (titled "Draft Canvas X.Y.Z", its body led by how to get it), deploys Pages, and, once the
Release exists, publishes `acltabontabon/draft-canvas` to Docker Hub (see
`.github/workflows/docker-publish.yml`) and builds the desktop installers into it, then tells installed
desktop copies about the update (`desktop-release.yml`, about 15 minutes after the rest). Desktop-only
changes go in the same `CHANGELOG.md` section as everything else, under its `### Desktop`.

The landing page at <https://acltabontabon.com/draft-canvas/> needs nothing from you at release time.
Its desktop download links are built from the root `package.json` version when it is deployed, so
cutting the tag updates them; only a *new* platform — a build for an architecture that has never
shipped before — needs a line added, in `www/index.html` beside the three that are there. A change to
the page's words deploys on its own, on a push to `main` that touches `www/`, without waiting for a
release; that deploy rebuilds the editor from the latest `vX.Y.Z` tag, never from `main`.
[`docs/reference/website.md`](docs/reference/website.md) has the rest.

The Docker Hub page's own description is edited on Docker Hub, under **Repository → Edit**, and is
the one part of a release that cannot be automated: Docker Hub answers the description API with 403
for an access token however it is scoped, and only the account password reaches it, which is not
worth putting in CI. It is written for someone who found the image before they found the project,
so it repeats what the README says rather than linking to it — which also means it does not follow
along on its own. Give it a look when a release changes what the product is.

Draft Canvas for VS Code (`vscode-extension/`) is released separately, from `extension-vX.Y.Z` tags,
with its own version and changelog — see [`vscode-extension/RELEASING.md`](vscode-extension/RELEASING.md).

Draft Canvas Desktop (`src-tauri/`) has no version or release of its own: it ships in every `vX.Y.Z`
release above. The one exception is a desktop preview ahead of a release, from a
`desktop-vX.Y.Z-alpha.N` tag: its own prerelease titled "Draft Canvas X.Y.Z-alpha.N", with a dated
`## [X.Y.Z-alpha.N]` section in `CHANGELOG.md`; its `X.Y.Z` may lead `package.json`'s
(`scripts/check-desktop-version.mjs` enforces both). See [Releasing](docs/guides/desktop.md#releasing),
and [Desktop updates](docs/reference/desktop-updates.md) for the update signing key.
