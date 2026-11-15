# Common edit token benchmark

Run from the repository root with signed-in `codex` and `claude` CLIs, installed Chromium and a
freshly built MCP sidecar (`cargo build --manifest-path src-tauri/Cargo.toml -p draft-canvas-mcp`):

```bash
node --import tsx benchmark/agent-edits/run.mjs
BENCH_REVIEW=1 node --import tsx benchmark/agent-edits/run.mjs
```

These are live, paid model calls, intentionally outside CI. Each prompt in [prompts.json](prompts.json)
starts with a fresh synthetic architecture fixture and conversation. Both clients run at low effort:
Codex `gpt-6-luna`, Claude `sonnet` (the result records the actual model). An optional positional
substring filters cases, for example `codex-description`. `BENCH_OUTPUT` sets the artifact directory;
otherwise the runner prints a new temporary directory. `BENCH_RUN` labels repeated samples.

The runner reads Nodi's brief, mode instructions, response schema and turn template from Rust source.
It verifies the sidecar's advertised planning tools against the generated source before spending
model tokens. The final decision executes only after a clean CLI exit, through the real sidecar
receipt executor and browser editor. The fixture broker admits only the exact authorized tool and
arguments. Native access, journal, cancellation and approval gates are covered separately by the
Rust and desktop integration tests; this fixture broker is not a substitute for those tests.

Input usage includes cached and cache-write tokens. No fixed client overhead is subtracted. Artifacts
include prompts, client events, receipts, before/after documents, pending proposals and `result.json`.
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

[results.json](results.json) retains the frozen baseline and two final samples per client/mode/prompt,
including failures. Recheck saved artifacts without model calls with
`node benchmark/agent-edits/collect.mjs output.json sample-label=/path/to/artifacts` (repeat the last
argument for each sample). Verification compares serialized content, so object-key order and omitted
`undefined` fields cannot create false failures.
