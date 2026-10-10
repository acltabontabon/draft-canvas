# Reliability and release acceptance

Draft Canvas is a local-first tool. Its readiness is judged by whether supported drawing, explaining,
saving and recovery journeys work, and whether publication depends on verified source and artifacts.
OS code signing and notarization are intentionally outside this milestone: installers remain ad-hoc
signed on macOS and unsigned on Windows. The in-app updater's signature checks remain mandatory.

## Release gates

[CI](../../.github/workflows/ci.yml) is reusable. It resolves a source ref to one commit, then runs
lint, tooling typechecks, build, coverage, license checks, the three-engine editor journeys,
offline and assembled-site checks, a Docker smoke check, dependency audits and performance budgets.
The build artifact records its source commit. Offline and assembled-site browser jobs test its
compiled files without rebuilding. The editor journeys run against Vite's development server at
the same source commit; several of those journeys also inspect source modules through that server.

[Release](../../.github/workflows/release.yml) waits for this workflow before creating a **draft**.
[Desktop acceptance](../../.github/workflows/desktop-ci.yml) must also pass before desktop packaging.
The release packages are checked for version and updater signatures; the arm64 macOS bundle is
started, and the Windows installer is installed into a temporary folder and its installed app started.
The Intel macOS package is cross-compiled: native Intel installation remains a manual acceptance item.
Only then is the release made public and the updater channels advanced.

Pages downloads the same-run verified web artifact and checks its recorded commit before uploading.
Site-only changes retain the previous released editor, build the combined artifact once and test it
in Chromium, Firefox and WebKit before deploying. Their unit/coverage and license checks run against
the selected editor source and current site. Site-only publication does not release a new editor.

Docker builds a multi-platform OCI archive containing SBOM and provenance manifests, then smoke-tests
both archived runtime platforms. A separate job holding Docker credentials copies that archive with
preserved digests to the registry. No publication build follows the tests.

Hosted [CI](https://github.com/acltabontabon/draft-canvas/actions/runs/38040880397),
[Desktop CI](https://github.com/acltabontabon/draft-canvas/actions/runs/38018279380) and
[site deployment](https://github.com/acltabontabon/draft-canvas/actions/runs/38018279754) passed on
10 October 2026. Release tags additionally verify signed update packages and the multi-platform
Docker publication path before promotion. Keep release tags and publishing workflows limited to
trusted maintainers. No signing certificate or paid service is required by this milestone.

## Recovery guarantees and limits

- A confirmed IndexedDB save writes the summary and body in one transaction. A synchronous body-write
  failure aborts the previously queued summary too. Failed autosaves retain the pending document for
  retry or export. Conflicts require a choice; recovery is not permission to overwrite another copy.
- Browser autosave normally starts after 700 ms without an edit, or after at most 4 seconds of
  continuous edits. This is scheduling latency, not a guaranteed durable-write deadline. A crash,
  force quit or power loss can lose edits that have not completed a save.
- The synchronous reload stash is for same-tab refresh/navigation only. It can fail when storage is
  full and does not protect against closing the tab or losing the browser profile.
- Persistent browser storage reduces eviction risk. It does not protect against clearing site data,
  losing the device or editing the wrong copy. Stale-backup reminders therefore apply even when the
  browser granted persistence. A reminder is not proof that a browser download was kept.
- A backup can salvage readable diagrams when another row is unreadable, but explicitly reports the
  partial result and does not reset the complete-backup date. A missing project manifest fails the
  backup instead of silently dropping grouping. Cancellation does not record a backup. Opaque
  document IDs are escaped in archive names, avoiding path traversal and case-insensitive filename
  collisions without changing the IDs inside the files; names stay within 255 UTF-8 bytes.
- Restoring never overwrites an existing diagram. Restore may stop on a storage failure after some
  copies were saved; those copies remain usable, and retrying may create additional copies.
- Desktop writes use an atomic temporary-file replacement and retain unsaved recovery copies in the
  app's own data folder. Existing recovery behavior is deliberately retained: rotating historical
  snapshots would need selection, retention and restore semantics. They are a later product feature,
  not a substitute for an independent exported backup.

## Performance acceptance

The automated supported workload is **200 shapes and 300 connectors**, including nested boundaries,
rooms, notes and attachments. This is a regression target, not an import limit or a promise of 60 Hz
on every device. Import ceilings remain hostile-input bounds. Larger diagrams remain available but
may lag; the [published measurements](performance.md#latest-results) show the tradeoffs.

`npm run perf:check` measures three iterations after warmup, then requires:

| Metric | Maximum |
| --- | --- |
| p95 frame time for pan, single-shape drag and selection | 50 ms |
| p95 input latency for those gestures | 100 ms |
| Worst gesture/tail long task, median across iterations | 250 ms |
| Medium diagram cold open, median | 3,000 ms |
| Longest task while opening, median | 1,000 ms |
| JS heap after opening | 256 MiB |
| SVG / PNG export | 1,500 / 6,000 ms |

The first local run passed: pan/drag p95 about 17 ms, selection about 33 ms, opening about 585 ms,
40 MiB JS heap, SVG 71 ms and PNG 943 ms. These are Apple M2 Pro measurements on 9 October 2026,
not a CI-runner calibration or ordinary-laptop validation. The coarse limits provide headroom for
shared runners and detect material regressions; tighten them only from repeatable evidence.
An idle frame floor over 25 ms fails acceptance as a throttled environment, rather than passing a
misleading run. Missing, failed, nonnumeric, duplicate or broken measurements fail the gate.
CI pins timing measurements to the `ubuntu-24.04-arm` runner image; browser journeys retain their
x64 matrix. The previous x64 pool supplied different EPYC generations, moving selection p95 from
50 to 67 ms between runs with unchanged selection code and roughly 32 ms input latency. Timing
limits stay unchanged. Reports retain CPU, OS and browser versions so comparisons can account for
the measurement environment; the runner label alone is not a guarantee of identical hardware.
Weekly/manual runs additionally measure larger workloads and long-session behavior; these retain
reports for investigation and do not claim a calibrated memory-leak gate.

## Dependency triage

`npm run audit:npm` scans both lockfiles and blocks unaccepted high/critical advisories.
`npm run audit:rust` requires cargo-audit 0.22.2 and blocks vulnerability and unsoundness advisories,
as well as yanked dependencies. Transport errors and malformed reports fail closed.
Full reports, including lower-severity and maintenance warnings, are retained as CI artifacts.
The scan also runs weekly so new advisories do not wait for the next code change.

Update compatible dependencies first. The source-map-js indexed-map denial-of-service advisory
GHSA-68fv-2mgg-jv7q was resolved by updating both lockfiles to 1.2.2.
Site-only deployments also refresh that compatible build-only dependency in the published editor's
lockfile before installation. They retain the full audit and browser acceptance gates, and record
the installed build-lock digest and source-map version beside the released source commit.
If no supported fix is available, an entry in
[advisory-exceptions.json](../../.github/advisory-exceptions.json) must name the ecosystem, advisory,
package, technical reason, tracking reference and expiry. Expired or incomplete entries fail even
when the current scan no longer contains the advisory. Remove obsolete exceptions promptly.

The initial RustSec unsoundness warning RUSTSEC-2024-0429 concerns glib 0.18.5, reached through Tauri's
Linux-only GTK stack. The supported macOS arm64 and Windows x64 dependency trees contain no glib.
Its exception expires on 8 November 2026 and must be reconsidered before adding Linux distribution.
GTK-family unmaintained warnings remain an upstream/platform maintenance risk and are retained in
reports. This triage is not a claim that Linux desktop is supported or cleared for release.

## Local diagnostic reports

About → **Diagnostic report…** previews a report before **Download report**. It contains the app
and document schema versions, timestamps and up to twenty recent failures with an operation category,
error category and optional element counts. It contains no document ids, names, labels, paths, URLs,
stacks or raw error messages. Unrecognized operations and error types become generic categories.
Nothing is uploaded; the record exists only in memory until the person downloads it and disappears
on reload. Development console logging remains more detailed for local debugging.

## Local automated verification (9 October 2026)

- Lint, application/tooling typechecks, web/desktop frontend builds and workflow validation (`actionlint`) passed.
- All 3,739 unit tests passed; coverage floors passed (71.02% statements, 61.79% branches,
  65.47% functions, 73.39% lines).
- Full Chromium `check:full` passed: 310 editor journeys, one offline reload and 13 assembled-site
  journeys. Full WebKit `check:full` passed: 301 editor journeys and 13 assembled-site journeys;
  nine editor cases and the offline-emulation case were skipped by existing platform guards.
- Both desktop browser suites passed all 80 journeys against the fake shell. `desktop:check`
  passed the desktop frontend build, formatting, Clippy, 297 Rust unit/integration tests and version alignment.
- Chromium offline and assembled-site journeys also passed with `DC_TEST_BUILT=1`, exercising the
  artifact-only server path without rebuilding.
- Dependency scans passed the policy above. No high/critical npm finding remains; the glib
  unsoundness exception is explicit, dated and limited to unsupported Linux desktop dependencies.
- Two existing gesture tests were corrected: the hit-corridor check samples the rendered path,
  and the pinch check waits for Fit, touches empty canvas and sends moves across frames. Both
  passed ten repetitions without retries before the complete suites were rerun successfully.

These local results were recorded before hosted acceptance. Docker's local daemon was unavailable,
and the native browser file-dialog drill was not completed.

## Hosted automated verification (10 October 2026)

- [CI on 60f3eca](https://github.com/acltabontabon/draft-canvas/actions/runs/38040880397) passed the
  three-engine editor, offline and assembled-site matrix, coverage, licensing, Docker smoke,
  dependency policy and performance gates. Firefox acceptance is verified on the Linux runner.
- [Desktop CI on 584bf60](https://github.com/acltabontabon/draft-canvas/actions/runs/38018279380)
  passed its fake-shell, Rust and packaged-startup checks.
- [Site deployment on 584bf60](https://github.com/acltabontabon/draft-canvas/actions/runs/38018279754)
  passed all three browser acceptance shards and deployed the verified artifact.

These are engineering checks. The manual observations below remain separate, and a release tag must
pass its own verification and artifact publication gates.

## Manual acceptance record

Automated checks do not establish installation usability, reader comprehension or power-loss safety.
Run each drill with disposable copies; record revision, platform, exact steps and actual outcome.

| Drill | Required evidence | Status |
| --- | --- | --- |
| Abrupt browser termination | Confirm a saved version, make a later edit, force quit, reopen; record what survived | Pending |
| Desktop interrupted save / unavailable drive | Prior confirmed file stays readable; pending edits recover or remain exportable | Pending |
| Clean install and upgrade | macOS arm64, Intel macOS and Windows; actual dialogs, file associations, unsaved work and updater behavior | Pending |
| Ordinary-laptop performance | Supported workload and hardware details against the budgets above | Pending |
| Drawing and recipient handoff | Five observations following [the existing protocol](explanation-usability.md), including keyboard/touch/screen-reader use | Pending |
| Release withdrawal rehearsal | Verify the procedure below with disposable artifacts | Pending |

Browser automation must pass all supported engines in CI. Firefox cannot currently launch in this
local macOS environment ("Could not find profile folder"); changing the runner's temporary directory
did not resolve it. Its hosted Linux matrix passed; local launch failure is an environment limitation,
not an application failure or an allowed CI skip.

## Withdrawal and recovery procedure

1. Stop promoting the bad release. Do not delete users' files or clear browser storage.
2. For desktop, run **Desktop update channels** with the last good tag and `force=true`. This stops
   new offers; it does not downgrade people who already installed the bad version.
3. For Docker, manually run **Docker** for the last good tag. Verification must pass before moving
   `latest` and the applicable minor tag. Record the resulting registry digests.
4. For web, run the current **Deploy to Pages** workflow from `main`, setting `release-tag` to the
   last good tag. It builds, verifies and promotes that editor source with the current site. Confirm hosted asset loading, document reopening and service-worker scope afterward.
5. Before offering an older editor, check schema compatibility on exported disposable documents.
   A client refusing a newer schema is not data loss; never bypass validation or rewrite users' files
   to force a downgrade. If rollback cannot read current files, ship a forward fix instead.
6. Publish a short incident note describing affected versions, workarounds, recovery instructions
   and what was verified. Keep the bad release discoverable with a clear warning rather than making
   the incident impossible to investigate.

These are reviewable procedures, not a claim that withdrawal has already been rehearsed.
