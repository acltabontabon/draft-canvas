# Agent edit token benchmark

Measures how many input tokens Nodi's agents (Codex and Claude) spend on common edits, through the real
sidecar and browser editor. These are live, paid model calls, so the benchmark stays out of CI.

## Running it

From the repository root, with signed-in `codex` and `claude` CLIs, Chromium installed, and a fresh
sidecar build (`cargo build --manifest-path src-tauri/Cargo.toml -p draft-canvas-mcp`):

```bash
BENCH_MAX_INPUT=3000 BENCH_NO_READS=1 node --import tsx benchmark/agent-edits/run.mjs
BENCH_REVIEW=1 BENCH_MAX_INPUT=3000 BENCH_NO_READS=1 node --import tsx benchmark/agent-edits/run.mjs
```

Each prompt in [prompts.json](prompts.json) starts from a fresh synthetic diagram. A positional argument
filters cases by substring, for example `codex-description`. Failed or refused attempts are kept and make
the runner exit non-zero.

| Variable | Effect |
| --- | --- |
| `BENCH_REVIEW=1` | Prepare a proposal instead of applying the edit; the saved diagram must not change |
| `BENCH_MAX_INPUT` | Fail a sample that uses this many input tokens or more (cached tokens count) |
| `BENCH_NO_READS=1` | Fail a sample that makes any model tool call |
| `BENCH_TURNS` | Chat length; `30` cycles the five prompts six times |
| `BENCH_FOLLOWUP=1`, `BENCH_HISTORY_DIR` | Ask a follow-up that needs an earlier run's chat history |
| `BENCH_EXPECT_REPLY=1` | With no history, the model must ask for clarification and change nothing |
| `BENCH_RESUME=1`, `BENCH_PROMPT_REF` | Compare against CLI session resumption with a frozen prompt |
| `BENCH_TREE`, `BENCH_SIDECAR`, `BENCH_PORT` | Measure another source tree and its separately built sidecar |
| `BENCH_OUTPUT`, `BENCH_RUN` | Artifact directory (default: a new temp directory) and a label for repeated samples |

## Results

Artifacts include the prompts, client events, receipts, before and after documents, pending proposals and
`result.json`. Recheck saved artifacts without model calls:

```bash
node benchmark/agent-edits/collect.mjs output.json sample-label=/path/to/artifacts
```

Earlier measurements are in `results.json`, `intent-results.json` and `history-results.json`. Model
choices and client overhead vary, so repeat both modes before drawing conclusions; the 3,000-token guard
is a check, not a guaranteed cap.
