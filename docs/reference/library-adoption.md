# Library adoption

Established libraries handle infrastructure boundaries. The diagram model, rendering, history and
persistence policy stay in the app.

| Area | Library | Scope | Verified by |
| --- | --- | --- | --- |
| Desktop wire types | `ts-rs` | File/project replies, menu commands, host events, updater payloads. `DesktopApi` stays the fakeable interface. | Rust test compares generated and checked-in types |
| Dialogs | React Aria | Portaling, background isolation, scroll lock, focus restore. The app keeps its initial-focus, IME Escape and Safari Tab handling. | Dialog/focus tests, browser accessibility journeys |
| ZIP | `fflate` | Writes stored (uncompressed) archives. The app's bounded reader checks CRCs and rejects compressed entries. | Format, reproducibility, system-unzip and backup round-trip tests |
| File notifications | `notify` | Debounced hints into the existing disk reconciliation path | Native checks, controller focus/notification tests |
| Generated tests | `fast-check`, `proptest` | Nested room serialization and collaboration (TS); atomic writes and conflict refusal (Rust) | Shrinkable, reproducible failures |
| Agent schema | Ajv (dev only) | Validates the agent gallery against the published `create_diagram` schema | Contract tests |
| Automatic layout | ELK (dev only) | Comparison harness only; not shipped | `npm run adoption:compare` |

## Desktop types

- After changing a covered Rust payload, run `npm run desktop:bindings` and commit `src/desktop/wire.ts`.
- `npm run desktop:rust` fails on drift without rewriting the file.
- Counters and timestamps are JavaScript numbers. Generated types do not replace runtime validation.
- Some payloads are still declared by hand, including recovery and agent-settings responses.

## Notification limits

- Watches are non-recursive, at most 32 directories per process (`src-tauri/src/watch.rs`).
- File grants watch their parent folder; project scans add folders that contain listed diagrams.
- Bursts coalesce for 150 ms, at most 1 s under continuous changes. Access events are ignored.
- Anything missed (no backend, budget exhausted, new subfolders) reconciles on window focus or agent access.
- Notifications never authorize a write or skip conflict checks.

## ELK comparison

`npm run adoption:compare` lays out the agent gallery's `create` cases with ELK and with the current
pipeline, and writes a report, standalone Ajv validation code and SVGs for both themes to
`benchmark/results/adoption/` (ignored).

- Inputs match: measured node sizes, nested groups, caption sizes, reading direction, a fixed ELK seed
  and freshly assigned anchors. Both outputs go through the app's quality checker.
- First result: ELK produced readability errors in most cases; the current pipeline had none.
- This screens one adapter, not ELK itself. It skips primary flows, satellites, shared trunks,
  nested rooms and ELK's own edge routes. ELK timings are layout only.
- To ship ELK, an adapter must cover those and pass the browser gallery.

Ajv stays a dev dependency: the published transport schema and the app's reader have different jobs
(request ids, defaults, semantic references, repair), and runtime code generation is not allowed.
