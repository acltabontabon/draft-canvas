# Reliability and release acceptance

## Release gates

| Workflow | What it gates |
| --- | --- |
| [CI](../../.github/workflows/ci.yml) | Resolves the ref to one commit. Lint, tooling typecheck and coverage once ([Shared checks](../../.github/workflows/shared-checks.yml)); build and `licenses:check`; editor journeys in Chromium, Firefox and WebKit; offline and assembled-site journeys against the built artifact; [Desktop checks](../../.github/workflows/desktop-ci.yml); [Dependency security](../../.github/workflows/security.yml); [Performance](../../.github/workflows/performance.yml) on tag pushes only |
| [Release](../../.github/workflows/release.yml) | Runs CI, then creates a **draft** release, then Desktop Release, Pages and Homebrew |
| [Desktop Release](../../.github/workflows/desktop-release.yml) | Checks version and updater signatures, starts the arm64 macOS app, installs and starts the Windows app. Only then publishes and moves the update channels |
| [Deploy the web](../../.github/workflows/pages.yml) | Publishes the verified artifact from the same run and checks its recorded commit |
| [Deploy site changes](../../.github/workflows/pages-site.yml) | Site-only changes: keeps the released editor, builds once, tests in all three browsers. Never releases a new editor |
| [Homebrew](../../.github/workflows/homebrew.yml) | Verifies both macOS installers against `SHA256SUMS.txt`, checks the cask, updates only that cask. Rerun it if the tap update fails; see [Homebrew releases](desktop-updates.md#homebrew-releases) |

- OS code signing is optional. Without signing secrets, macOS builds are ad-hoc signed and Windows
  builds unsigned. Updater signatures are always required.
- The Intel macOS package is cross-compiled and not started in CI.
- Keep release tags and publishing workflows limited to trusted maintainers.

## Recovery guarantees and limits

- **IndexedDB saves** write summary and body in one transaction. A failed autosave keeps the
  document for retry or export. Conflicts always ask.
- **Autosave** runs 700 ms after the last edit, or within 4 s of continuous editing. A crash or power
  loss can still lose unsaved edits.
- **Reload stash** covers same-tab refresh only, and fails when storage is full.
- **Persistent storage** lowers eviction risk only; backup reminders still apply.
- **Backups** skip unreadable diagrams and report it; a partial backup does not reset the
  last-backup date. A missing project manifest fails the backup.
- **Restore** never overwrites a diagram. Retrying after a storage error may add extra copies.
- **Desktop saves** replace the file atomically and keep unsaved recovery copies in the app's data
  folder. Not a substitute for an exported backup.

## Performance acceptance

Supported workload: **200 shapes and 300 connectors**, with nested boundaries, rooms, notes and
attachments. It is a regression target, not an import limit or a 60 Hz promise. Larger diagrams work
but may lag; see [published measurements](performance.md#latest-results).

`npm run perf:check` takes medians of three iterations after warmup. Limits are in
[`benchmark/budgets.ts`](../../benchmark/budgets.ts):

| Metric | Maximum |
| --- | --- |
| p95 frame time: pan, single-shape drag, selection | 50 ms (compared in whole ms) |
| p95 input latency, same gestures | 100 ms |
| Worst long task during or after a gesture | 250 ms |
| Medium diagram cold open | 3,000 ms |
| Longest task while opening | 1,000 ms |
| JS heap after opening | 256 MiB |
| SVG / PNG export | 1,500 / 6,000 ms |

- An idle frame floor over 25 ms, or any missing, invalid or broken measurement, fails.
- CI times on `ubuntu-24.04-arm`; the x64 pool varied between CPU generations.
- Only tag pushes run the gate. Tighten limits only from repeatable evidence.

## Dependency triage

- `npm run audit:npm` scans both lockfiles and blocks unaccepted high and critical advisories.
- `npm run audit:rust` uses cargo-audit 0.22.2 and blocks vulnerabilities, unsoundness and yanked
  crates.
- Network errors and malformed reports fail. The scan also runs weekly.

Update compatible dependencies first. If no fix exists, add an entry to
[advisory-exceptions.json](../../.github/advisory-exceptions.json) with ecosystem, id, package,
reason, tracking reference and expiry. Expired or incomplete entries fail.

Current exception: RUSTSEC-2024-0429 (glib 0.18.5), reached only through Tauri's Linux GTK stack.
The macOS and Windows dependency trees contain no glib. It expires 8 November 2026 and must be
resolved before shipping a Linux desktop build.

## Local diagnostic reports

Open **?** → **Diagnostic report…** in the web editor, or **Settings → Support** on desktop, to
preview a report, then choose **Download report**.

- Contains: app and schema versions, timestamps, and up to 20 recent failures with operation and
  error category and optional element counts.
- Never contains: document ids, names, labels, paths, URLs, stacks or raw error messages.
- Nothing is uploaded. The record lives in memory and is gone on reload.

## Manual acceptance record

Use disposable copies; record revision, platform, steps and outcome.

| Drill | Evidence | Status |
| --- | --- | --- |
| Abrupt browser termination | Confirm a save, edit, force quit, reopen; record what survived | Pending |
| Desktop interrupted save or unavailable drive | Last saved file stays readable; pending edits recover or can be exported | Pending |
| Clean install and upgrade | macOS arm64, Intel macOS, Windows: dialogs, file associations, unsaved work, updater | Pending |
| Intel macOS install | Native install of the cross-compiled package | Pending |
| Ordinary-laptop performance | Supported workload against the budgets above, with hardware details | Pending |
| Drawing and handoff | Five sessions following [the observation protocol](explanation-usability.md) | Pending |
| Release withdrawal | Rehearse the procedure below with disposable artifacts | Pending |

## Withdrawal and recovery procedure

Not yet rehearsed.

1. Stop promoting the bad release. Never delete users' files or clear browser storage.
2. Desktop: run **Desktop update channels** with the last good tag and `force` on. This stops new
   offers; it does not downgrade installed copies.
3. Homebrew: submit a reviewed tap correction. The automatic workflow refuses downgrades, and a tap
   rollback does not downgrade installed copies.
4. Web: run **Deploy the web** from `main` with `release-tag` set to the last good tag. Then check
   asset loading, reopening documents and service-worker scope.
5. Before offering an older editor, test it on exported disposable documents. If it cannot read
   current files, ship a forward fix instead. Never bypass validation or rewrite users' files.
6. Publish an incident note (affected versions, workarounds, recovery steps) and keep the bad
   release visible with a warning.
