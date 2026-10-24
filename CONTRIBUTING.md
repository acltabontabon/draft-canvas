# Contributing to Draft Canvas

Keep changes focused and the editor local-first.

## Setup

Needs **Node 22.22+** and **npm**. No backend or environment variables.

```bash
git clone https://github.com/acltabontabon/draft-canvas.git
cd draft-canvas
npm install
npm run dev        # http://localhost:5180
```

- **Collaboration session links:** also run `npm run dev:relay` (local relay on :8791). Direct invites work without it.
- **Desktop app:** install Rust and the Tauri prerequisites first; see [Building it yourself](docs/guides/desktop.md#building-it-yourself).
- **Website:** run `npm ci` in `www/` once, then `npm run site:dev` from the root.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Editor on :5180 |
| `npm run check` | Lint, tooling type-check, build and unit tests |
| `npm run desktop:dev` | Desktop app with hot reload |
| `npm run desktop:check` | Desktop build, Rust checks and version check |
| `npm run site:dev` | Website on :5280 |

All scripts and CI behavior: [development reference](docs/reference/development.md).

## Which checks for which change

- **Docs only:** check formatting, links, anchors and images (`npx vitest run tests/docs.test.ts`).
  No builds, lint or benchmarks unless asked.
- **Code, scripts or configuration:** `npm run check`, plus focused checks for what changed:

  ```bash
  npx vitest run tests/history.test.ts
  PLAYWRIGHT_BROWSER=chromium npx playwright test e2e/editing.spec.ts
  ```

- **Desktop or agent code:** `npm run desktop:check`; for agent changes also `npm run e2e:mcp`.
- **Browsers:** CI runs the full Chromium, Firefox and WebKit suites. `npm run check:full` is optional.

Report only checks you ran; pending CI has not passed.

## Repository map

| Path | Contents |
| --- | --- |
| `src/document/`, `src/depth/` | File model (operations, validation, migrations); rooms inside shapes |
| `src/store/`, `src/history/` | Editor and transient UI state; undo |
| `src/canvas/`, `src/ui/` | Canvas interaction and controls |
| `src/nodes/`, `src/edges/`, `src/render/` | Drawing, connector routing and text layout |
| `src/commands/` | Command palette, context menus and jump targets |
| `src/presentation/`, `src/sequence/` | Presentation camera and callouts; sequence export |
| `src/starters/`, `src/continuation/`, `src/openPoints/` | Starters, next-step suggestions, open points |
| `src/storage/`, `src/crypto/`, `src/export/`, `src/import/`, `src/share/` | Persistence, exports, Mermaid import, share links |
| `src/collab/` | Live collaboration; network code only in `src/collab/transport/` |
| `src/agent/`, `src/layout/` | Agent operations and automatic layout |
| `src/host/`, `src/desktop/` | Host interfaces; desktop screens, controller and Tauri adapter |
| `src-tauri/` | Native Rust shell; `src/collab/` is the LAN relay, `mcp/` the MCP sidecar |
| `skills/draft-canvas/` | Agent skill installed by the desktop app |
| `www/` | Website (own lockfile); `www/cloudflare/` has deploy config and the rendezvous relay |
| `tests/`, `e2e/` | Unit tests; browser specs (`e2e/desktop/` uses a fake shell) |
| `benchmark/`, `scripts/` | Performance harnesses; build, CI and release tooling |
| `docs/` | Guides, reference and media |

Entry points and host wiring: [development reference](docs/reference/development.md#entry-points-and-host-wiring).

## Conventions

- npm, 2-space indentation, single quotes, semicolons, trailing commas. oxlint, not Prettier.
- Comments explain why. Keep comments that record past bugs.
- Read [AGENTS.md](AGENTS.md) before changing core code; [Architecture](docs/reference/architecture.md)
  explains the boundaries.
- UI changes: check both themes, keyboard access, and presentation or drawing styles when affected.
- New or updated dependency, copied code or asset: add credits and notices in the same PR
  ([third-party attribution](docs/reference/third-party.md#maintaining-attributions)).

## Submitting a change

1. Discuss schema changes, new concepts or other large changes in an issue first.
2. Fork, branch and make one focused change.
3. Run the checks above.
4. Update guides when behavior changes. Add user-facing changes under `[Unreleased]` in `CHANGELOG.md`
   (Shared, Desktop or Web); see [release notes](docs/reference/releases.md#release-notes).
5. Open a PR against `main`: what changed, why, and how you checked it.

**Bugs:** include platform, version and steps to reproduce. Attach a small `.draftcanvas` file if it
helps and contains nothing private. **Feature requests:** describe the problem.
**Security:** report privately; see [SECURITY.md](SECURITY.md).

## Releases

1. Turn `[Unreleased]` in `CHANGELOG.md` into `## [X.Y.Z] - YYYY-MM-DD` and add a fresh `[Unreleased]`.
2. Set `X.Y.Z` in `package.json` and its lockfile (the desktop app takes its version from here).
3. Preview notes with `npm run release:notes -- vX.Y.Z` and `npm run release:whats-new -- desktop`.
4. Push the commit, then the `vX.Y.Z` tag. CI verifies, packages and publishes.

Full steps and checks: [Releases](docs/reference/releases.md).
