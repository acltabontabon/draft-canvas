# Common edit token benchmark

Run from the repository root with signed-in `codex` and `claude` CLIs, installed Chromium and a
freshly built MCP sidecar (`cargo build --manifest-path src-tauri/Cargo.toml -p draft-canvas-mcp`):

```bash
BENCH_MAX_INPUT=3000 BENCH_NO_READS=1 node --import tsx benchmark/agent-edits/run.mjs
BENCH_REVIEW=1 BENCH_MAX_INPUT=3000 BENCH_NO_READS=1 node --import tsx benchmark/agent-edits/run.mjs
```

These are live, paid model calls, intentionally outside CI. Each prompt in [prompts.json](prompts.json)
starts with a fresh synthetic architecture fixture and conversation. Both clients run at low effort:
Codex `gpt-6-luna`, Claude `sonnet` (the result records the actual model). An optional positional
substring filters cases, for example `codex-description`. `BENCH_OUTPUT` sets the artifact directory;
otherwise the runner prints a new temporary directory. `BENCH_RUN` labels repeated samples.
`BENCH_MAX_INPUT` requires strictly fewer input tokens than its value; `BENCH_NO_READS` requires
zero model tool calls. Omit these guards when measuring a baseline that needs reads.

The runner reads Nodi's brief, mode instructions, response schema and turn template from Rust source.
It verifies the sidecar's advertised planning tools against the generated source before spending
model tokens. The final decision executes only after a clean CLI exit, through the real sidecar
receipt executor and browser editor. The fixture broker admits only the exact authorized tool and
arguments. Native access, journal, cancellation and approval gates are covered separately by the
Rust and desktop integration tests; this fixture broker is not a substitute for those tests.
The editor revision is captured locally before the model starts and pinned on simple intents;
neither that revision nor a diagram snapshot is sent to the model. The host selects apply versus
proposal, generates proposal summaries and resolves names through the ordinary checked pipeline.

Input usage includes cached and cache-write tokens. No fixed client overhead is subtracted. Artifacts
include prompts, client events, receipts, before/after documents, pending proposals and `result.json`.
Codex's JSON event stream omits some `exec` calls, including tool discovery. The runner also audits
this synthetic run's local Codex transcript and records every tool-call name; missing transcripts
fail the audit. No transcript contents or personal context are copied into the report.
Failed or refused attempts are retained and make the runner exit nonzero. A successful sample must
change the requested field, preserve unrelated content, and, in review mode, leave the saved diagram
byte-for-byte unchanged while preparing a pending proposal. The proposal candidate is checked with
the real patch engine; accepting proposals is tested by the browser suite. Connection rewiring may
recompute that connection's anchors, but must preserve its label, semantics and all other content.

For a frozen-source comparison, set `BENCH_TREE`, `BENCH_SIDECAR` and optionally `BENCH_PORT`.
Use a separately built executable: Cargo's shared target directory can retain a different tree's
binary even when a build reports it fresh. Mismatched tool catalogs are a harness error, not a
benchmark sample. Repeat both modes before drawing conclusions; model choices and client overhead
vary, so these samples are not universal token caps. Review the JSON results, including failures,
alongside the PR's comparison table.

[intent-results.json](intent-results.json) compares local intents to the preceding compact-read
implementation, with two final samples per client/mode/prompt: all 40 completed below 3,000 input
tokens with zero model tool calls. It also retains 20 tuning samples, including a 5,915-token
Codex discovery outlier that led to the explicit no-discovery instruction and transcript audit.
One earlier batch was invalidated by a dev-server reload during a source edit; the revision check
refused that request. The runner now disables file watching so the synthetic shell cannot disappear
mid-call. These measurements are not a universal cap for long histories or ambiguous requests. The earlier
[results.json](results.json) retains the historical baseline and compact-read results, including the
failed proposal. Recheck saved artifacts without model calls with
`node benchmark/agent-edits/collect.mjs output.json sample-label=/path/to/artifacts` (repeat the last
argument for each sample). Verification compares serialized content, so object-key order and omitted
`undefined` fields cannot create false failures.
