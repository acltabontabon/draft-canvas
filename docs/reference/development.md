# Development reference

Commands and code locations. See [Contributing](../../CONTRIBUTING.md) for setup and verification,
[AGENTS.md](../../AGENTS.md) for implementation rules, and [Architecture](architecture.md) for design principles.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Editor dev server on :5180 |
| `npm run build` | Type-check and build into `dist/` |
| `npm run lint` | Run oxlint |
| `npm test` | Unit and integration tests |
| `npm run test:watch` | Watch unit tests |
| `npm run check` | Lint, tooling type-check, build and unit tests |
| `npm run check:full` | Optional full local verification |
| `npm run e2e:install` | Install browser drivers once |
| `npm run e2e` | Editor browser suite |
| `npm run e2e:offline` | Offline production-build suite |
| `npm run e2e:web` | Assembled web deployment suite |
| `npm run site:dev` | Landing page dev server on :5280 |
| `npm run build:web` | Assemble editor and website into `dist-web/` |
| `npm run desktop:dev` | Desktop app with hot reload |
| `npm run desktop:build` | Build a desktop installer |
| `npm run desktop:check` | Desktop build, Rust checks and version check |
| `npm run desktop:rust` | Rust checks; requires the desktop web build |
| `npm run e2e:desktop` | Desktop browser suite with a fake shell |
| `npm run agent:schemas` | Regenerate MCP tool schemas |
| `npm run perf` | Measure diagram loading and memory |
| `npm run perf:publish` | Update generated performance tables |
| `npx tsx e2e/docs-screenshots.ts` | Regenerate guide screenshots |

### Focused browser and unit checks

Full browser suites run in CI; use focused local checks when needed for code changes.

```bash
npx vitest run tests/history.test.ts
npx vitest run -t 'coalesces'
PLAYWRIGHT_BROWSER=chromium npx playwright test e2e/editing.spec.ts
```

To investigate a Firefox failure without retries:

```bash
PLAYWRIGHT_BROWSER=firefox npx playwright test e2e/look-inside.spec.ts \
  -g 'the depth map opens' --repeat-each=10 --retries=0 --trace=retain-on-failure
npx playwright test --project=firefox --last-failed --trace=retain-on-failure
npx playwright show-trace 'test-results/<failed-test>/trace.zip'
```

Wait for the required UI state rather than adding fixed sleeps. Editor specs use the dev server;
offline and deployment specs use production builds. Desktop browser specs do not need Rust.
`desktop:check` builds the web bundle before running Rust checks.

CI splits the editor suite across three jobs per browser, with one worker per job. A passing retry
still fails CI. Browser jobs use the official Playwright container, with its version selected from
that source's lockfile, so they do not install browsers or system packages on each runner. Coverage
runs independently of artifact production; browser checks start when the built artifact is ready.
The final `verify` job requires all applicable checks, including coverage, security and performance.

Pull requests and pushes to `main` that change only `docs/` Markdown/media or `README.md`,
`CONTRIBUTING.md`, `AGENTS.md`, `CODE_OF_CONDUCT.md` and `SECURITY.md` run workflow validation,
documentation link/anchor/image checks and the site build. They skip editor builds, coverage, browser
suites, audits and benchmarks. Everything else (including `CHANGELOG.md`, which feeds the editor)
runs full CI. Renames include both paths; missing comparison history falls back to full CI. Manual
runs and reusable callers (including releases) run every check by default. Keep `full-checks: true`
for release callers. Jobs and dependency installation steps have explicit time limits.

After a merge to `main`, web and desktop CI can reuse a completed successful PR run from this
repository. Each PR run records its tested merge revision and scope in a small evidence artifact.
CI resolves that commit independently and compares its entire Git tree with the landed commit,
including workflows, tests and lockfiles. The PR must be merged into `main` at that exact revision;
matching the PR head alone is insufficient. A docs-only result cannot replace full verification.
Reused runs link to the original verification in the source job summary. Web CI still validates
workflows and runs applicable security audits because advisories can change without source changes.

Missing or expired evidence, unavailable API/history, failed or unfinished PR runs, changed trees,
fork PRs and direct pushes use the normal checks described above. Forced pushes, manual runs and
release callers also use fresh verification; release builds never consume PR artifacts. Evidence
expires after seven days and is specific to a workflow run attempt.

Reusable CI and historical Pages builds validate alternate sources with `scripts/verify-source.mjs`
from the workflow's checkout. Selected revisions must belong to the default branch's history before
their code runs. This keeps manual runs from executing unmerged code in the default branch's cache scope.

## Repository map

| Path | Contents |
| --- | --- |
| `src/` | Shared React + TypeScript editor |
| `src/document/` | Model, operations, validation and migrations |
| `src/store/` | Editor and transient UI state |
| `src/canvas/`, `src/ui/` | Canvas interactions and controls |
| `src/nodes/`, `src/edges/`, `src/render/` | Drawing, text layout and rendering |
| `src/storage/`, `src/export/`, `src/host/` | Persistence, exports and host interfaces |
| `src/depth/`, `src/agent/`, `src/layout/` | Rooms, agent operations and layout |
| `src/desktop/` | Desktop screens, controller and Tauri adapter |
| `src-tauri/` | Native Rust shell |
| `src-tauri/mcp/` | Bundled MCP connector |
| `www/` | Separate landing-page project and lockfile |
| `tests/` | Unit and integration tests |
| `e2e/` | Browser specs; `e2e/desktop/` uses a fake shell |
| `benchmark/` | Performance and comparison harnesses |
| `scripts/` | Build, code generation and release tooling |
| `docs/` | Guides, reference and media |
| `public/` | Static editor assets |

At the root, `index.html` starts the editor. Build `dist/` for static self-hosting; see the
[self-hosting guide](../guides/self-hosting.md).
Playwright configs select editor, offline, web deployment or desktop suites.
The untracked `demo/` harness is optional; its lint and type-check entries are inactive when absent.

## Entry points and host wiring

| Concern | Location |
| --- | --- |
| Web entry | `index.html` → `src/main.tsx` → `src/App.tsx` |
| Desktop boot | `src/desktop/boot.ts` |
| Host detection | `src/host/hostInfo.ts` (`hostKind`) |
| Storage selection | `src/storage/index.ts` (`getRepository`) |
| Export saving | `src/export/download.ts` (`setFileSaver`) |
| Browser autosave | `src/store/useDocumentSession.ts` → `src/storage/autosave.ts` |
| Desktop saving | `src/desktop/controller.ts` → `src/desktop/tauri/api.ts` → `src-tauri/src/commands/documents.rs` |
