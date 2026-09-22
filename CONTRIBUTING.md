# Contributing to Draft Canvas

Thanks for taking a look. Draft Canvas is a small, opinionated tool, and this doc is meant to keep
it that way — quick to read, quick to act on.

## Running it locally

```bash
git clone https://github.com/acltabontabon/draft-canvas.git
cd draft-canvas
npm install
npm run dev        # http://localhost:5180
```

Node `>=22.14.0` (matches CI). No backend, no environment variables, no accounts to set up — clone
and go.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` | Type-check and produce a production build in `dist/` |
| `npm run lint` | oxlint |
| `npm test` | Unit and integration tests (Vitest) |
| `npm run test:watch` | Vitest in watch mode |
| `npm run e2e` | Browser tests (Playwright — run `npm run e2e:install` once first) |
| `npm run e2e:offline` | The same suite against a built, offline-served app |
| `npm run check` | Lint, type-check the e2e/benchmark/demo tooling, build, and unit tests together — **run this before opening a PR** |
| `npm run desktop:dev` | The desktop app (`src-tauri/`) with hot reload. Needs [Rust and Tauri's prerequisites](docs/guides/desktop.md#building-it-yourself) |
| `npm run desktop:build` | An installer for the desktop app |
| `npm run desktop:check` | The desktop build, the Rust checks (`fmt`, `clippy`, `test`) and the version check |
| `npm run e2e:desktop` | The desktop screens in the browser, against a faked shell. No Rust needed |

The desktop commands are only for work on the desktop app. Changes to the editor itself are checked by the rows
above, and don't need Rust installed.

Focused runs, when you're iterating on one thing:

```bash
npx vitest run tests/history.test.ts    # one unit test file
npx vitest run -t 'coalesces'           # by test name
npx playwright test e2e/editing.spec.ts # one e2e spec
```

## Conventions

npm (not yarn/pnpm), 2-space indent, single quotes, semicolons, trailing commas. oxlint, no
Prettier. TypeScript with project references. Comments explain *why*, not *what* — several existing
ones record a bug found the hard way; don't remove those. See [`AGENTS.md`](AGENTS.md) for the
fuller set of load-bearing rules (where node appearance lives, why text is only ever wrapped once,
why `src/document/` can't import React, and so on) before touching core rendering, storage, or the
document model.

## Submitting a change

1. Fork, branch, make your change.
2. `npm run check` — fix anything it catches. Don't work around a real failure to get green output.
3. Open a PR against `main` with what changed and why. Small, focused PRs are easier to review than
   one PR doing three things.
4. **Discuss anything large before writing it.** If a change touches the document schema, the
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

### Highlights for What's New

What's New shows a handful of a release's bullets, not all of them. Mark the ones worth telling
someone using the app by leading with a **bold title** and ending with `<!-- highlight -->`:

```markdown
- **Rename in place** — from Rename File… on the File menu, without leaving Draft Canvas.
  <!-- highlight -->
```

The marker is invisible on GitHub and dropped from every release body. A release's What's New is its
own highlights plus its prereleases' — nobody runs an alpha's version number — so an alpha's highlights
first appear in the app when the release they lead to ships.

What's New for 1.9.4 and earlier is frozen as it was written, in `src/releases/productReleases.ts`
(`ARCHIVED_RELEASES`). Don't add to it.

### Previewing

```bash
npm run release:notes -- desktop-v1.10.0-alpha.3               # what that desktop prerelease would say
npm run release:notes -- v1.10.0 --platform web                # one platform's part of a release
npm run release:notes -- v1.10.0 --draft                       # a release whose section isn't written yet
npm run release:whats-new -- desktop --draft 1.10.0            # What's New as the desktop build shows it
```

A missing or duplicated version, a heading that isn't a version, mixed headings, a highlight without a
title, or a release with nothing for the platform it's publishing all fail loudly, naming what to fix —
the release workflows would stop rather than publish empty or wrong notes. `tests/changelog.test.ts`
covers the rules; `npm test` runs the real changelog through them.

## Release workflow

When preparing a release:

1. Keep `CHANGELOG.md`'s `[Unreleased]` section current as you go, in the shape above, marking the
   highlights you'd want in What's New.
2. Before cutting the release, rename `[Unreleased]` to the version with today's date
   (`## [1.10.0] - 2026-10-01`), leave a fresh `## [Unreleased]` above it, and preview the notes.
3. Bump the version through the normal release process, then ship. Once `package.json`'s version
   reaches that section, About → What's New shows it on its own — no other wiring needed.

Pushing the `vX.Y.Z` tag does the rest: one version, one GitHub Release, everything in it. It creates
the Release (titled "Draft Canvas X.Y.Z", its body led by how to get it), deploys Pages, and, once the
Release exists, publishes `acltabontabon/draft-canvas` to Docker Hub (see
`.github/workflows/docker-publish.yml`) and builds the desktop installers into it, then tells installed
desktop copies about the update (`desktop-release.yml`, about 15 minutes after the rest). Desktop-only
changes go in the same `CHANGELOG.md` section as everything else, under its `### Desktop`.

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
(`scripts/check-desktop-version.mjs` enforces both). See [Releasing](docs/guides/desktop.md#releasing).

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
