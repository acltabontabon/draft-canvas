# Contributing to Draft Canvas

Keep changes focused and preserve the editor's local-first behavior.

## Running it locally

Use **Node 22.14 or later** and **npm**. No backend or environment variables are needed.

```bash
git clone https://github.com/acltabontabon/draft-canvas.git
cd draft-canvas
npm install
npm run dev        # http://localhost:5180
```

Desktop development also needs Rust and Tauri prerequisites; see [Building the desktop app](docs/guides/desktop.md#building-it-yourself).
For the landing page, run `npm ci` inside `www/` once, then `npm run site:dev` from the root.

## Common commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the editor |
| `npm run check` | Lint, type-check, build and run unit tests for code changes |
| `npm run desktop:dev` | Start the desktop app |
| `npm run desktop:check` | Check the desktop build, Rust code and versions |
| `npm run site:dev` | Start the landing page |

The full command list, repository map and specialized checks are in the [development reference](docs/reference/development.md).

## Which checks for which change

- **Docs only:** check formatting, links, anchors and referenced images. No tests, builds, lint or benchmarks unless requested. Preview rendered docs when layout matters.
- **Code, scripts or configuration:** run `npm run check` and focused checks for the changed behavior.
- **Browser coverage:** full Chromium, Firefox and WebKit suites run in CI. Run focused local browser checks only when needed. `npm run check:full` is optional unless requested or needed for an issue.

For example:

```bash
npx vitest run tests/history.test.ts
PLAYWRIGHT_BROWSER=chromium npx playwright test e2e/editing.spec.ts
```

Report the checks actually performed; do not claim pending CI has passed.

## Conventions

Use npm, 2-space indentation, single quotes, semicolons and trailing commas. Use oxlint, not Prettier.
Comments explain why; preserve comments recording past bugs.

Read [AGENTS.md](AGENTS.md) before changing core code. The [architecture reference](docs/reference/architecture.md)
explains the module boundaries. For UI changes, check both themes and keyboard access, plus presentation
or drawing styles when affected.

## Submitting a change

When adding or updating a dependency, copied source or asset, follow the
[third-party attribution guidance](docs/reference/third-party.md#maintaining-attributions).
Include credits and required notices in the same PR as the integration.

1. Discuss schema changes, new concepts or other large changes in an issue before writing code.
2. Fork, branch and make one focused change.
3. Follow the checks above and fix relevant failures.
4. Update guides when behavior changes. Add user-facing changes under `CHANGELOG.md`'s `[Unreleased]`
   section using Shared, Desktop or Web; see the [release reference](docs/reference/releases.md#release-notes) for the format.
5. Open a PR against `main` explaining what changed, why and how you checked it.

For bugs, include the platform, version and steps to reproduce; attach a small `.draftcanvas` example
if useful, after checking it contains nothing private. Feature requests should explain the problem.
Report security concerns privately as described in [SECURITY.md](SECURITY.md).
