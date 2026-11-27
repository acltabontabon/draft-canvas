# Contributing to Draft Canvas

Thanks for helping. Keep each change focused, and read the principles below before proposing a feature.

## Principles

Draft Canvas is built on **your architecture, your agents, your decisions**:

- No feature may need a Draft Canvas account, an API key held by Draft Canvas, or a server that sees
  diagrams.
- An agent is a collaborator, not a command runner: it explains and proposes. Its changes arrive as
  proposals, drawn where they apply, and nothing skips review unless the person chose that.
- An agent is limited to what the person allowed, and Draft Canvas enforces that limit itself.
- The canvas stays the subject. Agent surfaces point at the diagram; they don't take it over.

## Setup

You need **Node 22.22.2+** and npm. There is no backend and no environment to configure.

```bash
git clone https://github.com/acltabontabon/draft-canvas.git
cd draft-canvas
npm install
npm run dev        # editor on http://localhost:5180
```

- **Session links for live collaboration:** also run `npm run dev:relay` (a local relay on :8791).
  Direct invites work without it.
- **Desktop app:** install Rust and the Tauri prerequisites, then run `npm run desktop:dev`. See
  [Building it yourself](docs/guides/desktop.md#building-it-yourself).
- **Website:** run `npm ci` in `www/` once, then `npm run site:dev` (on :5280).

## Checks

| Change | Run |
| --- | --- |
| Docs only | `npx vitest run tests/docs.test.ts` (links, anchors and images) |
| Code, scripts or configuration | `npm run check` (lint, type-check, build and unit tests), plus focused tests |
| Desktop or agent code | `npm run desktop:check`; for agent changes also `npm run e2e:mcp` |

Focused tests run one file at a time:

```bash
npx vitest run tests/history.test.ts
PLAYWRIGHT_BROWSER=chromium npx playwright test e2e/editing.spec.ts
```

CI runs the full Chromium, Firefox and WebKit suites. In your PR, list only the checks you ran. Every
script is described in the [development reference](docs/reference/development.md).

## Repository map

| Path | Contents |
| --- | --- |
| `src/document/`, `src/depth/` | The file model: operations, validation, migrations; views inside shapes |
| `src/store/`, `src/history/` | Editor state and undo |
| `src/canvas/`, `src/ui/` | Canvas interaction and controls |
| `src/nodes/`, `src/edges/`, `src/render/` | Drawing, connector routing and text layout |
| `src/commands/` | Command palette, context menus and search |
| `src/presentation/`, `src/sequence/` | Presenting; sequence diagrams |
| `src/gallery/`, `src/traffic/`, `src/openPoints/` | Starters gallery, outage walk, open points |
| `src/collab/` | Live collaboration; network code only in `src/collab/transport/` |
| `src/agent/`, `src/layout/` | Agent operations and automatic layout |
| `src/storage/`, `src/export/`, `src/import/` | Persistence, export and import |
| `src/host/`, `src/desktop/` | Host interfaces; the desktop app's screens and Tauri adapter |
| `src-tauri/` | Native Rust shell, the local network relay, and the MCP sidecar (`mcp/`) |
| `skills/draft-canvas/` | The agent skill the desktop app installs |
| `www/` | Website and docs site (own lockfile); `www/cloudflare/` holds deploy config and the relay |
| `tests/`, `e2e/` | Unit tests; browser tests (`e2e/desktop/` uses a fake desktop shell) |
| `benchmark/`, `scripts/` | Performance harnesses; build, CI and release tooling |

## Conventions

- npm, 2-space indentation, single quotes, semicolons and trailing commas. oxlint, not Prettier.
- Comments explain why. Keep comments that record past bugs.
- Read [AGENTS.md](AGENTS.md) before changing core code. It lists the rules the code relies on, and
  [Architecture](docs/reference/architecture.md) explains the boundaries behind them.
- For UI changes, check both themes, keyboard access, and presenting or drawing styles where affected.
- A new dependency, copied code or asset needs its credits in the same PR
  ([third-party attribution](docs/reference/third-party.md#maintaining-attributions)).

## Submitting a change

1. Discuss schema changes, new concepts and other large changes in an issue first.
2. Fork, branch from `main` (the 1.x line; 2.x work happens on `develop/2.x`) and make one focused change.
3. Run the checks above.
4. Update the guides when behaviour changes, and add user-facing changes under `[Unreleased]` in
   `CHANGELOG.md` ([format](docs/reference/releases.md#release-notes)).
5. Open a PR against `main` saying what changed, why, and how you checked it.

Bug reports need the platform, version and steps to reproduce; attach a small `.draftcanvas` file if it
contains nothing private. Report security issues privately: see [SECURITY.md](SECURITY.md).

## Reference

| Topic | Page |
| --- | --- |
| How the app fits together | [Architecture](docs/reference/architecture.md) |
| Scripts, CI and entry points | [Development](docs/reference/development.md) |
| The `.draftcanvas` file format | [Schema](docs/reference/schema.md) |
| What shapes and connectors mean | [Semantics](docs/reference/semantics.md) |
| Tools for coding agents (MCP) | [Agent integration](docs/reference/agent-integration.md) |
| Diagram history in Git | [Evolution](docs/reference/evolution.md) |
| Mermaid import | [Mermaid import](docs/reference/mermaid-import.md) |
| Storage, sharing and network use | [Privacy and security](docs/reference/privacy.md) |
| Benchmarks | [Performance](docs/reference/performance.md) |
| Releasing, updates and recovery | [Releases](docs/reference/releases.md) |
| The website and the relay | [Website](docs/reference/website.md) |
| Credits | [Third-party acknowledgements](docs/reference/third-party.md) |
