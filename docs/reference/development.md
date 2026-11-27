# Development reference

Every npm script, what CI runs and when, and where each host is wired in. Setup and which checks
to run are in [Contributing](../../CONTRIBUTING.md); implementation rules in
[AGENTS.md](../../AGENTS.md).

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` / `preview` | Editor dev server on :5180; serve the built `dist/` |
| `npm run dev:relay` | Local collaboration relay on :8791, used by the dev server for session links |
| `npm run build` | Type-check and build into `dist/` |
| `npm run site:dev` / `site:build` | Website dev server on :5280; build the website |
| `npm run build:web` / `site:preview` | Assemble editor and website into `dist-web/`; serve it the way it is hosted |
| `npm run check` | Lint, tooling type-check (`typecheck:tooling`), build and unit tests |
| `npm run check:full` | `check` plus the `e2e`, `e2e:offline` and `e2e:web` suites (optional) |
| `npm run lint` | oxlint |
| `npm test` / `test:watch` / `test:coverage` | Unit and integration tests; watch mode; V8 coverage |
| `npm run e2e:install` | Install Playwright browsers once |
| `npm run e2e` / `e2e:offline` / `e2e:web` | Editor, offline production-build and assembled-site browser suites |
| `npm run e2e:desktop` | Desktop browser suite against a fake shell (no Rust needed) |
| `npm run e2e:mcp` | Real MCP sidecar to editor round trip; run after `desktop:check` |
| `npm run desktop:dev` / `desktop:build` | Desktop app with hot reload (web side on :5198); a desktop installer |
| `npm run desktop:check` | `desktop:web` build, `desktop:rust` (`cargo fmt`, `clippy`, tests) and `desktop:version` |
| `npm run desktop:bindings` | Regenerate `src/desktop/wire.ts` from Rust payloads |
| `npm run agent:schemas` | Regenerate the tool catalogs in `src-tauri/mcp/` and the skill's `pairings.json` from `src/agent/schema.ts` |
| `npm run agent:sidecar` | Build the MCP sidecar |
| `npm run tauri` | The Tauri CLI |
| `npm run audit:npm` / `audit:rust` | Dependency advisory audits; see [Dependency triage](releases.md#dependency-triage) |
| `npm run release:notes` / `release:whats-new` | Preview release notes and What's New; see [Releases](releases.md) |
| `npm run icons:generate` / `icons:check` | Regenerate or verify the Simple Icons catalog |
| `npm run licenses` / `licenses:check` | Regenerate or verify `THIRD_PARTY_LICENSES.txt` |
| `npm run starters:fixtures` | Refresh the vendored starter snapshot in `tests/fixtures/starters/` |
| `npm run perf`, `perf:*` | Benchmarks and the release gate; see [Performance](performance.md) |
| `npm run adoption:compare` | ELK/Ajv comparison harness |
| `npx tsx e2e/docs-screenshots.ts` | Regenerate guide screenshots |

`desktop:rust` needs the desktop web build (`desktop:web`) first.

## Focused checks

Beyond the single-file runs in Contributing, filter by test name with `npx vitest run -t 'coalesces'`.

Reproduce a flaky Firefox test without retries:

```bash
PLAYWRIGHT_BROWSER=firefox npx playwright test e2e/look-inside.spec.ts \
  -g 'the depth map opens' --repeat-each=10 --retries=0 --trace=retain-on-failure
npx playwright show-trace 'test-results/<failed-test>/trace.zip'
```

- Wait for UI state; never add fixed sleeps.
- Editor specs use the dev server (Playwright reuses one already on :5180). Offline and deployment
  specs use production builds.

## CI

`ci.yml` is the entry point for pull requests and `main`.

- **Flaky tests fail.** CI retries once, but `--fail-on-flaky-tests` fails a test that passes only on
  retry.
- **Desktop checks** (`desktop-ci.yml`) run only when `src/`, `src-tauri/`, desktop tests, root
  package or build config, workflows or CI scripts change (`scripts/ci-plan.mjs`).
- **Docs only:** changes limited to `docs/**/*.md`, `docs/media/` images and video, `README.md`,
  `CONTRIBUTING.md`, `AGENTS.md`, `CODE_OF_CONDUCT.md` and `SECURITY.md` run workflow validation, doc
  link checks and the site build only. `CHANGELOG.md` is compiled into the editor, so it runs full CI.
- Manual runs, release callers (`full-checks: true`) and missing history always run everything.
- `verify` is the final required job. Performance budgets run only for tagged releases.

### Reusing a PR run on `main`

After a merge, CI may reuse a successful PR run instead of re-testing (`scripts/ci-reuse.mjs`):

- The PR must be merged at the exact revision its run tested, with an identical Git tree.
- Its evidence artifact must cover the same scope (full, desktop). It expires after 7 days.
- Fork PRs, direct and forced pushes, manual runs and releases always verify fresh.
- Workflow validation and security audits still run.

`scripts/verify-source.mjs` refuses to check out a revision that is not on the default branch's
history.

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
