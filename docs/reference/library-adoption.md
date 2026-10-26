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
- The comparison includes a second adapter that keeps ELK's own orthogonal edge sections as native
  pins and bends. Section coordinates are translated from their containing graph; ports must lie
  on the actual shape's attachment band. Unsupported compound junction sections keep the baseline
  route and are counted separately, so incomplete coverage is visible in `adaptedRoutes`.
- On 26 October 2026, the 21 create cases had no readability errors with the current pipeline.
  ELK node placement with native routing had errors in 10 cases; preserving usable ELK routes had
  errors in 13. The latter adapted 75 of 150 connectors. SVGs for all three results and both themes
  are written beside the report.
- These results screen these adapters, not ELK itself. They do not yet preserve primary flows,
  satellites, shared trunks, ELK label placements or layout inside nested rooms. ELK timings are
  layout only. A shipping adapter must cover those and pass the browser gallery.

Ajv stays a dev dependency: the published transport schema and the app's reader have different jobs
(request ids, defaults, semantic references, repair), and runtime code generation is not allowed.

## Other routing and layout candidates

The aim is a clean diagram without repeated manual arrangement. A candidate must improve the
rendered picture while preserving authored routes, semantics, caption readability and canvas/export
parity; replacing a pathfinder alone does not establish that.

- [ELK Layered](https://eclipse.dev/elk/reference/algorithms/org-eclipse-elk-layered.html) remains the
  strongest next layout experiment: layers, crossing minimization, ports, labels and compound graphs.
  The existing dev dependency lets the adapter improve without adding runtime weight yet.
- [libavoid](https://www.adaptagrams.org/documentation/libavoid) targets interactive obstacle-avoiding
  orthogonal and polyline routing. It is C++; a browser integration needs a WebAssembly adapter and
  lifecycle handling. [JointJS documents a standalone integration](https://docs.jointjs.com/learn/features/automatic-layouts/standalone-link-routing/)
  with separately served WASM and LGPL notices. Evaluate it against pins, request/reply lanes,
  shared trunks and the routing corpus before adoption.
- [React Flow Smart Edge](https://github.com/tisoap/react-flow-smart-edge) is a closer React Flow
  integration for obstacle avoidance. It still needs an adapter for the worker-safe agent and export
  pipeline and evidence for caption placement and shared corridors.
- [MSAGL.js](https://microsoft.github.io/msagljs/docs/api/) offers layout and several routing modes;
  [Dagre](https://github.com/dagrejs/dagre) offers directed graph layout. Both are candidates for a
  separate comparison, not tested by the ELK harness.

For now, native repair checks the whole drawing before accepting a candidate and polishes crossings
and detours after layout selection. Keep an already clean diagram unchanged; leave unresolved cases
in the receipt so an agent can explain them instead of repeatedly arranging the same view.
