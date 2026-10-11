# Library adoption

This change adopts established libraries at infrastructure boundaries and keeps the diagram model,
rendering, history, and persistence policies in the application.

| Area | Decision | Verification |
| --- | --- | --- |
| Desktop wire types | Generate file/project replies, menu commands, host events and updater payloads with `ts-rs`. Keep `DesktopApi` as the fakeable interface. | Rust tests compare the generated declarations with the checked-in file. |
| Dialogs | React Aria owns portaling, background isolation, scroll locking and focus restoration. Keep the existing initial-focus, IME Escape and Safari Tab policies. | Existing dialog/focus tests and browser accessibility journeys. |
| ZIP | `fflate` writes stored archives; the existing bounded reader checks CRCs and rejects compressed entries. Older installations can still restore exports. | ZIP format, reproducibility, system-unzip and backup round trips. |
| Native notifications | `notify` sends debounced hints to the existing disk reconciliation path. | Native checks and the same controller tests for focus and notification events. |
| Generated cases | `fast-check` exercises nested room serialization; `proptest` exercises atomic writes and conflict refusal. | Unit tests, with reproducible/shrinkable failures. |
| Agent schema | Ajv validates the create gallery against the published schema in tests. | Found and fixed removal of the actual `description` property while stripping schema descriptions. |
| Automatic layout | Keep ELK in a development-only comparison harness. | The initial adapter does not meet the current renderer's readability checks. |

## Maintaining desktop types

Run `npm run desktop:bindings` after changing a covered Rust payload, then commit
`src/desktop/wire.ts`. `npm run desktop:rust` checks for drift without rewriting it.
JSON counters and timestamps are explicitly represented as JavaScript numbers. The Rust host's
opaque JSON agent context is refined in the TypeScript interface by the existing bridge contract;
generating types does not replace runtime validation. Some payloads remain manually declared,
including recovery and agent-settings responses.

## Notification limits

Subscriptions are nonrecursive and bounded to 32 directories per process. File grants subscribe to
their parent; project scans add directories containing listed diagrams. This avoids recursively
watching dependency and build trees. Notification bursts coalesce for 150 ms, with a one-second
maximum delay under continuous changes. Access events are ignored.

Unavailable native backends, exhausted watch budgets, newly added unobserved subdirectories, and
missed events still reconcile on focus or agent access. Notifications never authorize a write or
replace conflict checks. The TypeScript fake shell exercises the same event path without Rust.

## Repeating the adoption comparison

Run `npm run adoption:compare`. It writes a report, standalone Ajv validation code, and baseline/ELK
SVGs in both themes under `benchmark/results/adoption/` (ignored run output).

The harness uses the 18 create fixtures, identical measured node sizes, nested groups, caption sizes,
a fixed ELK seed, the requested reading direction, and freshly assigned Draft Canvas anchors.
It checks repeated-run equality and evaluates both outputs with Draft Canvas's existing quality
checker. The first adapter produced readability errors in 11 of 18 cases; the current pipeline had
none. All 18 ELK outputs were repeatable and all 18 requests passed the corrected schema.

This is an integration screening result, not a claim that ELK is inferior. It does not translate all
primary-flow, satellite, shared-trunk or nested-room behavior, use ELK's edge routes, or run the current
pipeline's repairs on ELK output. Timings cover ELK layout only and must not be compared with full
composition. A production adapter needs to cover those differences and pass the browser gallery
before replacing the current layout. ELK is not shipped in the editor bundle.

Ajv remains a development dependency: the published transport schema and the application's reader
have different responsibilities (transport request IDs, defaults, semantic references, and repair).
The harness demonstrates standalone generation without adding runtime code compilation or changing
which existing documents can open. Contract tests now prevent the concrete nested-description drift.
