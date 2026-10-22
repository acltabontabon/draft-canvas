# Development reference

Scripts, CI behavior and host wiring. Setup, the repository map and which checks to run are in
[Contributing](../../CONTRIBUTING.md); implementation rules in [AGENTS.md](../../AGENTS.md).

## Commands

### Editor and website

| Command | Purpose |
| --- | --- |
| `npm run dev` | Editor dev server on :5180 |
| `npm run dev:relay` | Local collaboration relay on :8791, used by the dev server for session links |
| `npm run build` | Type-check and build into `dist/` |
| `npm run site:dev` | Website dev server on :5280 |
| `npm run build:web` | Assemble editor and website into `dist-web/` |
| `npm run site:preview` | Build, stage and serve `dist-web/` the way it is hosted |

### Checks and tests

| Command | Purpose |
| --- | --- |
| `npm run check` | Lint, tooling type-check, build and unit tests |
| `npm run check:full` | `check` plus every browser suite (optional) |
| `npm run lint` | oxlint |
| `npm test` / `npm run test:watch` | Unit and integration tests |
| `npm run test:coverage` | Unit tests with V8 coverage |
| `npm run e2e:install` | Install Playwright browsers once |
| `npm run e2e` | Editor browser suite |
| `npm run e2e:offline` | Offline production-build suite |
| `npm run e2e:web` | Assembled web deployment suite |
| `npm run audit:npm` / `npm run audit:rust` | Dependency advisory audits |

### Desktop and agents

| Command | Purpose |
| --- | --- |
| `npm run desktop:dev` | Desktop app with hot reload (web side on :5198) |
| `npm run desktop:build` | Build a desktop installer |
| `npm run desktop:check` | Desktop web build, Rust checks and version check |
| `npm run desktop:rust` | `cargo fmt`, `clippy` and tests; needs the desktop web build |
| `npm run desktop:bindings` | Regenerate `src/desktop/wire.ts` from Rust payloads |
| `npm run e2e:desktop` | Desktop browser suite against a fake shell (no Rust needed) |
| `npm run e2e:mcp` | Real MCP sidecar to editor round trip; run after `desktop:check` |
| `npm run agent:schemas` | Regenerate `src-tauri/mcp/tools.json` from `src/agent/schema.ts` |

### Generated files and performance

| Command | Purpose |
| --- | --- |
| `npm run icons:generate` / `icons:check` | Regenerate or verify the Simple Icons catalog |
| `npm run licenses` / `licenses:check` | Regenerate or verify `THIRD_PARTY_LICENSES.txt` |
| `npm run perf` | Measure diagram loading and memory |
| `npm run perf:check` | Interaction and lifecycle budgets (the release gate) |
| `npm run perf:publish` | Update the generated tables in [Performance](performance.md) |
| `npm run adoption:compare` | ELK/Ajv comparison harness; see [Library adoption](library-adoption.md) |
| `npx tsx e2e/docs-screenshots.ts` | Regenerate guide screenshots |

## Focused checks

```bash
npx vitest run tests/history.test.ts
npx vitest run -t 'coalesces'
PLAYWRIGHT_BROWSER=chromium npx playwright test e2e/editing.spec.ts
```

Reproduce a flaky Firefox test without retries:

```bash
PLAYWRIGHT_BROWSER=firefox npx playwright test e2e/look-inside.spec.ts \
  -g 'the depth map opens' --repeat-each=10 --retries=0 --trace=retain-on-failure
npx playwright show-trace 'test-results/<failed-test>/trace.zip'
```

- Wait for UI state; never add fixed sleeps.
- Editor specs use the dev server (Playwright reuses one already on :5180). Offline and deployment
  specs use production builds.
- The optional, untracked `demo/` harness is type-checked only when present.

## CI

`ci.yml` is the entry point for pull requests and `main`.

- **Shared checks** (`shared-checks.yml`): lint, tooling type-check, unit tests with coverage, once.
- **Browsers:** the editor suite runs in three shards per browser. CI retries once but
  `--fail-on-flaky-tests` fails a test that passes only on retry.
- **Desktop** (`desktop-ci.yml`): runs when `src/`, `src-tauri/`, desktop tests, root package or
  build config, workflows or CI scripts change (`scripts/ci-plan.mjs`).
- **Docs only:** changes limited to `docs/**/*.md`, `docs/media/` images and video, `README.md`,
  `CONTRIBUTING.md`, `AGENTS.md`, `CODE_OF_CONDUCT.md` and `SECURITY.md` run workflow validation, doc
  link checks and the site build only. `CHANGELOG.md` is compiled into the editor, so it runs full CI.
- **`verify`** is the final required job. Performance budgets run only for tagged releases.
- Manual runs, release callers (`full-checks: true`) and missing history always run everything.

### Reusing a PR run on `main`

After a merge, CI may reuse a successful PR run instead of re-testing (`scripts/ci-reuse.mjs`):

- The PR must be merged at the exact revision its run tested, with an identical Git tree.
- Its evidence artifact must cover the same scope (full, desktop). It expires after 7 days.
- Fork PRs, direct and forced pushes, manual runs and releases always verify fresh.
- Workflow validation and security audits still run.

`scripts/verify-source.mjs` refuses to check out a revision that is not on the default branch's history.

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
| Live collaboration | `src/store/collabBridge.ts` → `src/collab/` → `src/collab/transport/` |
| Collaboration relay address | `VITE_COLLAB_RELAY` (see `vite.config.ts`); empty disables session links |

Build `dist/` for static hosting; see [Self-hosting](../guides/self-hosting.md).
