# Performance

A reproducible Chromium benchmark that answers exactly three questions:

1. How fast does a realistic diagram load?
2. How much memory does it use?
3. Does dragging a node still feel responsive?

## Running it

```
npm run perf
```

Builds the production bundle, serves it, and measures two workloads — Typical and Large — in
headless Chromium. Takes roughly 1-3 minutes.

```
npm run perf:stress
```

Same measurements, plus a third, larger "Stress" workload. No target runtime — it's here for
occasionally checking the tool still holds up at scale, not for every-day use.

Both commands write `benchmark/results/latest.json` (always overwritten — no history of past
runs) and print a terminal summary. If two or more workloads ran, `benchmark/memory-chart.svg`
(JS heap vs. node count, committed at the repo root so it renders in the README) is written too.

## Workloads

Each is a deterministic diagram tiled from Draft Canvas's own real starters (microservices,
event-driven, CQRS, hexagonal, saga), not invented fixtures — regenerate them with
`npm run perf:regen-fixtures` if the starter catalog changes.

| Workload | Approx. size |
|---|---|
| Typical | ~90 nodes / ~80 edges |
| Large | ~225 nodes / ~190 edges |
| Stress | ~500 nodes / ~430+ edges (only under `perf:stress`) |

## What's measured

- **Load** — wall-clock time from importing the workload file to the diagram rendering (node count
  matches, two idle animation frames have passed).
- **JS Heap** — `JSHeapUsedSize` read via the Chrome DevTools Protocol after a forced GC pass. This
  is JS heap specifically, not overall process RAM or "memory usage" — DevTools Protocol doesn't
  expose the latter, and this doc won't call it that.
- **Drag** — wall-clock time for one 40-step drag of the first node, mirroring `e2e/scale.spec.ts`'s
  proven gesture pattern. Each measured run is undone (`Meta+Z`) before the next, so iterations
  stay comparable.

Each number is a median of 3 measured iterations (plus 1 discarded warmup iteration). With this
few samples, a percentile beyond the median would be false precision, so none is calculated — the
JSON result still carries `minMs`/`maxMs` per timing, which is enough to catch "one run was wildly
off" without pretending statistical rigor.

## Comparing against a baseline

```
npm run perf:save-baseline
```

Runs the benchmark and saves the result to `benchmark/baseline.json` (git-tracked, committed
deliberately when you want a new reference point). Every subsequent `npm run perf` / `perf:stress`
that finds this file prints a "Compared with baseline" block of plain percentage diffs
(`(current - baseline) / baseline * 100`). This is informational only — there are no pass/fail
thresholds or CI gates tied to it.

## Publishing results to the README

```
npm run perf:publish
```

Regenerates the `<!-- performance:start -->…<!-- performance:end -->` block in `README.md` from
`benchmark/results/latest.json`. Run `npm run perf` first.

## CI

The [`Performance`](../.github/workflows/performance.yml) GitHub Actions workflow runs the
identical `npm run perf` command on demand via `workflow_dispatch` and uploads
`benchmark/results/latest.json` and `benchmark/memory-chart.svg` as artifacts. It is not part of
the regular CI pipeline and gates nothing.
