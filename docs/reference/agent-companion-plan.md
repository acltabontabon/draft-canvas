# Agent companion: implementation plan

Status: Released in 1.16.0 with Claude Code and Codex; [open questions settled](#settled-decisions). Desktop only. The
companion's mascot is **Nodi** (NOH-dee), after the nodes diagrams are made of; the agent keeps its own
name (Claude Code, Codex) wherever the person talks to it. Mockup: the "Canvas Agent Companion" design (pixel mascot,
floating composer, conversation card, inline proposal review). Reviewed against the code by a second
agent (Codex CLI); its findings are folded in.

The person types a prompt on the canvas. Draft Canvas runs **their own** coding agent (Claude Code
first) as a background process, with the current diagram and selection attached. The agent edits
through the existing MCP tools, and the companion shows its progress and the resulting proposal in
place. Agents still reach diagrams only through the bridge; the companion is a new way to start one,
with a narrower policy than an external agent gets.

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| How the agent runs | The agent's own CLI as a child process (`claude -p … --output-format stream-json`) | Uses the CLI and sign-in the person already has. No adapter, no runtime download, no API key. |
| Internal interface | Shaped like the [Agent Client Protocol](https://agentclientprotocol.com): session, prompt, update, cancel, stop reason | A native ACP backend can be added later without changing the UI or the event model. No ACP code now. |
| First agent | Claude Code | Most common, documented streaming output, `--session-id`/`--resume`, `claude auth status`. Codex follows ([Phase 6](#phase-6-codex-backend)). |
| What it can touch | Draft Canvas MCP tools only, for **this diagram only**, enforced in the broker | A prompt typed on a canvas must not run shell commands, edit code or reach other diagrams. |
| How changes land | A proposal by default, enforced in the broker; **Apply directly** is a per-person preference | Accept stays the only commit (`applyToFile`), one undo step. |
| Access | The same gate as any agent: **Allow agent access** on, diagram in an enabled folder | No second way in. The companion offers the one-click fixes when either is missing. |
| Where state lives | Conversation: transient page store. Session id per diagram: app-local file in Rust | Never in the document, history, autosave or export. The agent's own transcript is the agent's (see [Privacy](#privacy-and-security)). |

## How a prompt travels

1. The composer makes a `runId` (UUID) and calls `controller.companionSend({ runId, diagramId, text,
   selection, room })`. Selection and room are captured at send time. Making the id in the page means
   events that arrive before the command returns are already attributable.
2. `companion_send` (Rust) resolves the diagram with `DiagramIndex::find` and `scope::in_scope`,
   requires it to be the active document, and registers a **run policy**: `{ runId, diagramId, mode:
   proposal | direct }`. Then it spawns the CLI.
3. The CLI starts `draft-canvas-mcp` from a per-run MCP config that sets `DRAFT_CANVAS_RUN=<runId>`;
   the sidecar sends it as `run` in `hello`.
4. For a connection whose `run` matches a live policy, the broker **narrows** what the token allows:
   every call must name the run's diagram (`list_diagrams` and `create_diagram` are refused),
   and in proposal mode `update_diagram` is refused with a code that tells the agent to use
   `submit_proposal`. A `run` with no live policy is refused outright, so a stale or guessed tag cannot
   widen anything; a connection without `run` is an ordinary external agent, unchanged.
5. The broker records each page request id under its run, and `run` is copied into the page's
   `AgentContext` for every request, including the direct update path that builds its own
   `AgentRequest`.
6. Each stdout line goes through the backend's parser into `RunEvent`s, pushed as
   `HostEvent::Companion { run, event, sequence }` on the existing `Channel<HostEvent>`, and kept in a bounded
   per-run buffer for reload recovery.
7. The page's companion store folds events into the conversation. A proposal tagged with this run is
   reviewed in the card.
8. On exit: `Stopped { reason }`, the run's MCP config file is deleted, the policy is closed and the
   agent session id is recorded for the diagram.

## The interface (Rust, `src-tauri/src/companion/protocol.rs`)

Names follow ACP so a future ACP backend maps one to one. Same `ts-rs`/serde conventions as `HostEvent`
(`tag = "type"`, kebab-case variants, camelCase fields), and every new type is listed in
`src-tauri/src/bindings.rs`, which emits only the declarations it names. `HostEvent` derives `Eq`, so
nothing here holds a float.

```rust
pub struct PromptRequest {            // ACP session/prompt
    pub run_id: String,               // made by the page
    pub diagram_id: String,
    pub text: String,                 // the person's words, unchanged
    pub selection: Option<Selection>, // {nodes, edges} captured at send
    pub room: Vec<String>,            // DepthPath of the current room
    pub agent: AgentKind,             // claude-code (codex later)
}

pub enum RunEvent {                   // ACP session/update
    Started { session: String },      // agent session id (resume key)
    MessageChunk { text: String },    // agent_message_chunk
    ToolCall { id: String, tool: String, status: ToolStatus },                 // tool_call
    ToolCallUpdate { id: String, status: ToolStatus, error: Option<String> },  // tool_call_update
    Stopped { reason: StopReason, summary: Option<String>, cost_micro_usd: Option<u64> },
}

pub enum ToolStatus { Pending, InProgress, Completed, Failed }
pub enum StopReason { EndTurn, Cancelled, MaxTurns, Refusal, Failed { message: String } }

pub trait Backend: Send + Sync {
    fn kind(&self) -> AgentKind;
    fn locate(&self) -> Availability;                     // Installed { path, version } | Missing | TooOld
    fn sign_in(&self, path: &Path) -> SignIn;             // claude auth status --json: method, transcript folder; a hint
    fn command(&self, run: &RunSpec) -> Result<std::process::Command, AppError>;
    fn parse(&self, line: &str, state: &mut ParseState) -> Vec<RunEvent>; // unknown lines → []
}
```

`tool` is the MCP tool name (`update_diagram`). Friendly step text ("Reading Order processing",
"Drawing a preview") is page copy, mapped in `src/desktop/companion.ts`.

## Claude Code backend (`src-tauri/src/companion/claude.rs`)

Reuses helpers that are private today and become `pub(crate)` (or move to a shared
`src-tauri/src/agent/cli.rs`): `find_claude` and `path_with` from `agent/clients.rs`,
`connectable_sidecar` from `commands/agent.rs`, and the free function `agent::sidecar_path()`.

Flags checked against Claude Code 2.1.295:

```text
claude -p
  --output-format stream-json --verbose --include-partial-messages
  --mcp-config <run dir>/mcp.json --strict-mcp-config
  --tools ""                                  # no built-in tools: no Bash, Read, Edit, WebFetch
  --allowedTools "mcp__draft-canvas__*"       # Draft Canvas tools run without a prompt
  --permission-prompts none                   # anything else that would prompt is denied
  --settings '{"disableAllHooks":true}'       # see "Isolation" below; precedence to verify
  --append-system-prompt <companion brief>    # static text only
  --session-id <uuid>                         # first turn; later turns: --resume <uuid>
```

- **Prompt on stdin**, not argv: never in a process list, no length limit.
- **Per-turn context goes in the prompt, not the system prompt.** Claude records the system prompt
  once per conversation and reuses it on resume, so the brief stays static (who Draft Canvas is, the
  rules). Each turn's message starts with a context block (diagram id and title, room, captured
  selection ids to pass as `scope`, mode), then the person's words. The agent is told to read with
  `read_diagram` for that room and to use the captured ids as `scope`, not to call `read_selection`,
  which reads the selection at call time and may have moved.
- **Working directory**: an app-owned empty folder, `<app_local_data_dir>/companion/work`, so no
  project `CLAUDE.md`, settings or hooks from a cloned repository load.
- **Isolation, honestly.** The work folder and `--strict-mcp-config` do not stop the person's own user
  settings, plugins and skills from loading. `--bare` would skip them but also turns off OAuth and
  keychain sign-in, which subscription users need, so it is not an option. `disableAllHooks` in
  `--settings` is the planned switch for hooks; Phase 1 verifies that a flag setting overrides user
  settings, and the docs say what still loads.
- **MCP config**: written per run, mode 0600, in `<app_local_data_dir>/companion/runs/<runId>/`,
  removed when the run stops:
  `{"mcpServers":{"draft-canvas":{"command":"<sidecar>","env":{"DRAFT_CANVAS_RUN":"<runId>"}}}}`.
- **PATH**: the binary's folder first (`path_with`, as `run_cli` does), so npm installs find `node`.
- **Before the first run**: `locate` reads `claude --version` and refuses versions older than the
  tested minimum ("Update Claude Code to use the companion"); `sign_in` reads `claude auth status --json`
  for `authMethod` (cost line) and `projectsDirectory` (where transcripts live).

| stream-json line | `RunEvent` |
| --- | --- |
| `system` / `init` with `session_id`, `mcp_servers` | `Started`; `draft-canvas` not `connected` → `Stopped { Failed: "Couldn't reach Draft Canvas" }` |
| `stream_event` text delta | `MessageChunk` |
| `assistant` content `tool_use` (`mcp__draft-canvas__<tool>`) | `ToolCall { InProgress }` |
| `user` content `tool_result` (`is_error`) | `ToolCallUpdate { Completed / Failed }` |
| `result` | From `is_error`, `subtype`, `stop_reason` and the error details together, never `subtype` alone: `EndTurn`, `MaxTurns`, `Refusal` or `Failed`. Cost from `total_cost_usd`; tokens from `usage` (`input_tokens`, `cache_creation_input_tokens` and `cache_read_input_tokens` are all read in; the last is the cached share). |
| anything else, or unparseable | ignored |

Parser tests run against recorded fixtures of real output, including a large `render_diagram` image
result. An exit without a `result` line is `Failed` with the last stderr line, worded the way `added()`
words setup failures.

## Running processes (`src-tauri/src/companion/runner.rs`)

There is no long-running child process in the app yet; this is the first.

- Add tokio's `process` feature to `src-tauri/Cargo.toml`.
- Stdin piped (prompt written, then closed); stdout read with a bounded line reader (32 MiB per line,
  which covers `render_diagram`'s 8 MiB image after base64; a longer line ends the run); stderr kept as
  a 64 KiB ring for error messages.
- **Own process group** (`process_group(0)` on unix; a job object with `CREATE_NO_WINDOW` on Windows),
  so stopping the agent also stops the sidecar it started.
- **Limits**: one run per diagram, two at once; a run with no output for 5 minutes stops.

The hardening review also bounds total output (128 MiB across stdout and stderr), parsed event text
(1 MiB), live events (20,000) and recovery events (2,000). Adjacent reply chunks merge in recovery, so a streamed reply
keeps its beginning. CLI setup probes have their own 1 MiB output cap and deadline through pipe
closure; Codex refuses startup when its feature restrictions cannot be verified. A terminal event
closes the run's policy and stops a lingering process, and Stop applies during setup as well as
after process launch. See the current [agent reference](agent-integration.md#nodi-the-desktop-companion)
for the runtime contract.

### Stopping a run

Killing the CLI is not enough: broker tasks outlive the connection, and page work is cancelled per
request id. **Stop**, in order:

1. Close the run's policy atomically: any new call from that run is refused as `CANCELLED`.
2. For each page request recorded under the run: before its commit gate, `agent.page.cancel(id)`;
   past it, let it finish and report "Applying…", as Cancel does today.
3. SIGTERM the process group, SIGKILL after 3 s, reap.
4. `Stopped { Cancelled }`, or `EndTurn` with a note if an update was already past its gate.

### Quit and updates

Stop every run and wait for the children to be reaped (bounded, 3 s) **before** exit continues:
in `on_run_event`'s `RunEvent::Exit` arm (`src-tauri/src/lifecycle.rs`) next to
`agent.shutdown("quit")`, and before the updater hands control to an installer, which on Windows can
end the app inside the install call (`src-tauri/src/updater/backend.rs`).

### Sessions

`<app_local_data_dir>/companion/sessions.json`, diagram id → `{agent, session, updatedAt}`, at most
200 entries, 30 days, written atomically. **New conversation** forgets the entry; it does not delete
the agent's own transcript.

### Commands and events

Each new command goes in the three lists `src/wiring.rs` checks (`lib.rs`, `build.rs` `COMMANDS`,
`capabilities/default.json`), and the handler count in `wiring.rs` goes from 66 to 71. `src/desktop/wire.ts`
is regenerated with `npm run desktop:bindings`.

| Command | Does |
| --- | --- |
| `companion_agents()` | Installed backends, version and sign-in. Lazy: finding `claude` may start a login shell, like `agent_clients`. |
| `companion_send(request)` | Validates access and scope, registers the policy, spawns. Errors are `AppError`. |
| `companion_cancel(runId)` | [Stopping a run](#stopping-a-run). |
| `companion_runs()` | Live runs and the last two completed turns, with buffered events and sequence highwaters for reload recovery. |
| `companion_forget(diagramId)` | Drops the stored session. |

New `HostEvent::Companion { run, event: RunEvent, sequence }`; `agent-request` context gains `run?: string`.

## Sidecar and broker

- `src-tauri/mcp/src/bridge.rs`: read `DRAFT_CANVAS_RUN` once and send it as an optional `run` in
  `hello`. Optional, so `BRIDGE_VERSION` is unchanged and an older app ignores it.
- `src-tauri/src/agent/bridge.rs`: keep `run` on the connection.
- `src-tauri/src/agent/broker.rs`: apply the run policy before dispatch (diagram, tool set); record
  page request ids per run; add `run` to the context in `to_page` **and** in the direct update path that
  builds its own `AgentRequest`.
- `src-tauri/src/agent/proposals.rs` and the native proposal JSON in `src-tauri/src/commands/agent.rs`
  (which lists fields explicitly): proposals record `run`. `Proposal` in `src/desktop/api.ts` and
  `AgentOp` in `src/desktop/agentActivity.ts` gain `run?: string`.

## Page side

| File | Change |
| --- | --- |
| `src/desktop/api.ts`, `src/desktop/tauri/api.ts` | `companionAgents`, `companionSend`, `companionCancel`, `companionRuns`, `companionForget`. |
| `src/desktop/controller.ts` | Route `companion` host events to the store; the five methods; `companionRuns()` after `host_ready` and on reload. |
| `src/desktop/companion.ts` (new) | Module-level transient store, like `agentActivity.ts`: conversations by diagram id, turns, steps, status. A pure `applyRunEvent(conversation, event)` reducer and the tool → step-text map. No React. |
| `src/desktop/ui/Companion.tsx` (new) | Mascot + pill, conversation card, composer. Selection read with `useShallow`. |
| `src/desktop/ui/mascot/pixels.ts`, `Mascot.tsx` (new) | Pixel rows, palette and faces as data; one `<svg shape-rendering="crispEdges">` of merged runs; moods `idle`, `working`, `waiting`, `happy`, `asleep`; still under `prefers-reduced-motion`; `role="img"` labelled with the mood. |
| `src/ui/Editor/EditorScreen.tsx` | Lazy `CompanionChunk` beside `ProposalPanelChunk` inside `.dc-editor-canvas`. Not rendered while presenting, for a collaboration guest or for a read-only document. `j` case in the mod-key switch. |
| `src/store/uiStore.ts` | `companionOpen` + setter (transient). `ProposalPreview` gains an `owner` (`panel` or `companion`); a surface clears the preview only if it owns it. |
| `src/commands/registry.ts` | `companion.toggle` in `viewCommands`, only when `__DESKTOP__ && hostKind() === 'desktop'`. The shortcut catalog test builds its context without a desktop host, so it needs a desktop-aware fixture before `⌘J` goes in `shortcutSections.ts`. |
| `src/lib/preferences.ts` | `companion.agent` (chosen backend), `companion.apply` (`proposal` or `direct`). |
| `src/desktop/ui/AgentActivity.tsx` | Skip ops whose `run` belongs to a live companion conversation; the card shows them. |
| `src/desktop/ui/ProposalPanel.tsx` | Move dry run, conflict check, Accept and Reject into a shared `useProposalReview(proposalId, owner)` hook used by the panel and the card. Accept keeps its single `applyToFile`. Opening the same proposal in the panel hands preview ownership to the panel. The badge keeps counting **every** pending proposal, so one from a forgotten or reloaded conversation can still be reviewed. |
| `src/desktop/ui/desktop.css` | Companion styles on existing tokens; `--dc-z-chrome`. |

### Where it sits on the canvas

Bottom-right of `.dc-editor-canvas`, 24 px from the right, above the status bar.

| Neighbour | Rule |
| --- | --- |
| Proposal badge/panel (bottom-right) | The badge moves left of the companion. While the proposal panel is open the companion is hidden: it shares the corner, and even the mascot would cover the panel's buttons. |
| Open points panel (right, bottom) | Hidden while it is open, for the same reason. |
| Inspector strip (bottom centre) | Below 1100 px of canvas width, the open card collapses while something is selected; the composer stays. |
| Outline panel (docked right) | No change: it shrinks the canvas column and the companion moves with it. |
| Fit and **Focus changes** | The open companion's width is reserved like `PANEL_RESERVED_WIDTH`. |
| Agent previews and proposal ghosts | Drawn by the existing `AgentPreviewLayer` and `ProposalPreviewLayer`; the companion adds only an agent cursor label. |

### States the UI handles

| State | Shown |
| --- | --- |
| No agent installed, or too old | Asleep mascot, **How to install** / **Update Claude Code**. |
| Not signed in (a hint before sending, or the run's error) | "Claude Code isn't signed in. Run `claude` once in Terminal to sign in." **Send** stays available. |
| Agent access off | **Allow agent access** (Settings → AI agents). On macOS, if turning it on needs a restart for background work, that is said here. |
| Diagram not in an enabled folder, or a quick draft | **Allow agents in this folder** / **Save to a folder first**. |
| Running | Working mascot, steps from `ToolCall`s, **Stop**. |
| Window hidden on macOS 12–13 or Windows | "Keep Draft Canvas open while the agent works" (tool calls time out when the page is suspended). |
| Proposal from this run | Waiting mascot, inline review. |
| Stopped with an error | The message, **Try again**; the conversation is kept. |

## Privacy and security

- Draft Canvas still sends nothing itself. The companion starts a program the person installed, which
  talks to its own provider. That is new and is said plainly in [Privacy](privacy.md) and the agent
  guides: the provider sees what the agent reads, and the agent keeps its own transcript of each turn
  (Claude Code under `~/.claude/projects/`), which **New conversation** does not delete.
- The privacy test stays as is: streaming arrives over the Tauri channel, not a network API in `src/`.
- Prompt injection from diagram text is bounded in the broker, not by instructions: one diagram,
  Draft Canvas tools only, proposals unless the person chose **Apply directly**.
- No secrets in argv: the prompt on stdin, the run id in a 0600 file, the bridge token in `agent.json`.
- What still runs inside the agent (the person's own plugins and skills) is listed in the docs.

## Phases

Code phases end with `npm run check` and the focused checks listed; the docs phase follows the
docs-only rule in [AGENTS.md](../../AGENTS.md#verification).

### Phase 1: runner and Claude backend

`companion/{mod,protocol,runner,claude,sessions}.rs`, the commands, `HostEvent::Companion`, stopping,
quit and update hooks. Tests use a fake CLI (a script that prints recorded fixtures, stalls, floods a
long line or exits early), so they need no network or sign-in. Verify `disableAllHooks` precedence.
Checks: `cargo test --workspace` in `src-tauri` (wiring, bindings), `npm run desktop:check`.

**Built** (`src-tauri/src/companion/`, `src-tauri/src/commands/companion.rs`). Where it differs from
the plan above:

- **Stopping is the process half only.** Stop terminates the agent's process group; closing the run
  policy and cancelling page requests (steps 1 and 2 of [Stopping a run](#stopping-a-run)) need the
  run tag, so they land in Phase 2.
- **Windows** originally used `taskkill /T /F`. Release hardening replaced it with a kill-on-close
  Job Object assigned while the process is suspended, before its first thread runs. Cancellation
  and parent exit end that job before pipe readers join. The Windows runner tests run only in CI.
- **Minimum version** is 2.1.295, the version the flags were checked against, until an older one is checked.
- **Verified since** with real runs (see [Real runs](#real-runs-2026-10-24)): the hooks switch, and the
  parser against recorded real turns. `companion/fixtures/claude-turn.jsonl` stays as the hand-written
  turn with a proposal in it.

### Phase 2: run policy through the sidecar and broker

`DRAFT_CANVAS_RUN` → `hello.run` → policy, request registry, `AgentContext.run`, `Proposal.run`.
Checks: `cargo test --workspace` including `mcp/tests/sidecar.rs`; a hello without `run` behaves as
today; a run cannot list, read or change another diagram, cannot `create_diagram`, and cannot
`update_diagram` in proposal mode; an unknown `run` is refused; Stop refuses calls admitted after it.

**Built** (`src-tauri/src/agent/runs.rs`, the run checks in `bridge.rs` and `broker.rs`, the hello in
`mcp/src/bridge.rs`). Notes:

- **New answers an agent can get:** `RUN_LIMIT` (another diagram, or a tool the companion doesn't
  offer), `PROPOSAL_ONLY` (`update_diagram` while changes are reviewed first, with a hint to send the
  same ops to `submit_proposal`), `CANCELLED` (the run has ended), and a `RUN_ENDED` refusal of a hello
  naming a run that isn't open. Phase 5 documents them under Errors.
- **`list_diagrams` is refused** for a run rather than narrowed to its diagram; the turn prompt already
  gives the diagram id. `list_proposals` is narrowed to the run's diagram; `get_proposal` checks the
  proposal's diagram.
- **Stop's order** is as planned: `Agent::end_run` closes admission and cancels uncommitted page
  requests, then the process group is stopped. A run whose update was already past its gate still
  ends as `Cancelled`; the "finished with a note" case in step 4 is left to the UI phases, which can
  see the applied change.
- **`AgentOp.run`** on the page waits for Phase 3, which is the first code to read it. `AgentContext.run`
  and `Proposal.run` are in the page types now.

### Phase 3: companion UI

Store, reducer, `Companion.tsx`, mascot, command, shortcut fixture, placement rules, reload recovery.
Checks: `tests/desktop/companion.test.ts` (reducer, step text), `companion-ui.test.tsx` (RTL with a
fake controller, like `proposal-panel.test.tsx`), the shortcut catalog test, and
`e2e/desktop/companion.spec.ts` with `mockShell.ts` emitting companion events.

**Built** (`src/desktop/companion.ts`, `src/desktop/ui/Companion.tsx`, `src/desktop/ui/mascot/`).
Notes:

- **Proposal review** opens the existing review panel at the run's proposal (**Review the change**);
  reviewing inside the card is Phase 4. The controller finds a turn's proposal by its `run` when the
  run stops, when the shell says agent state changed, and when the review panel closes.
- **The help screen** lists ⌘J only in the desktop app: rows can be `desktopOnly`, and the shortcut
  catalog records the companion command apart from the fixture's host-less command list.
- **Running-run snapshots carry the prompt**, so a reloaded page shows what was asked.
- **The desktop e2e suite** draws into the canvas's top-right corner where it used to draw into the
  bottom-right, which the resting companion now occupies.
- **Not built yet:** the inspector-strip collapse is a window-width rule (`max-width: 1100px`), not
  the canvas column's width; Fit and **Focus changes** don't reserve the open companion's width; and
  **Continue in Terminal** (the card would need the agent's working folder and session id) is not in
  the card.

### Phase 4: inline review

`useProposalReview` and preview ownership; AgentActivity skips companion ops; badge rules.
Checks: `proposal-panel.test.tsx` and `proposal-review.spec.ts` unchanged and passing, plus the card's
Accept and Reject, preview ownership between panel and card, and these cases: a collaboration guest
cannot open the companion; a collaborator's edit during Accept turns it into a conflict; selective
undo of an accepted proposal keeps remote changes; access turned off mid-run stops the run.

**Built** (`src/desktop/ui/useProposalReview.ts`, `src/desktop/ui/chipPlace.ts`, changes in
`Companion.tsx`, `ProposalPanel.tsx`, `AgentActivity.tsx`). Shaped by review in the session, under the
[principle](principles.md) that the canvas stays the subject and the agent is a collaborator:

- **The review is on the canvas, not in a panel.** A "Proposed change" chip sits beside the dashed
  ghost (left of it first, then above, right or below; never over it), with Accept, Reject and
  **Details** (the full review panel). When a proposal arrives the camera moves only as far as it
  takes to clear the companion, at the person's zoom. **Show me** joins them only while the change is
  out of view, and brings it back: offered always, it did nothing beside a change already on screen.
- **A proposal under review is the boldest thing on the canvas.** A faint ghost over a diagram at full
  strength read as hardly anything proposed, so while a proposal is shown it is drawn solid, outlined
  in teal (boundaries with their names), and the diagram around it steps back. An agent still working
  keeps the quieter live ghost.
- **A change that moves shapes is shown on tracing paper.** Drawing the moved shapes a second time
  over the real ones made a tidy-up unreadable, so the diagram goes under a sheet holding the whole
  diagram as the change leaves it. Teal marks what really changes (new, renamed, recoloured,
  regrouped); a shape that only moves is drawn plain and leaves a faint outline where it stands now,
  with a dotted trail to its new place (`movedShapes` and `changedBeyondPlace` in `agentGhostDiff.ts`,
  `TracingSheet` in `AgentPreviewLayer.tsx`). A boundary growing to fit is not a move. The chip's
  **Now / Proposed** switch lifts the sheet to compare. The change's bounds take in where moved shapes
  stand now as well as where they go, so the chip covers neither.
- **The review panel frames the change beside itself** once, when it is worked out (the panel covers
  the right of the canvas, where a re-layout runs), and lists changes in the diagram's words:
  geometry counted into one layout line ("5 shapes moved · 4 connectors rerouted"), boundaries by name,
  colours as colours (`reviewRows.ts`).
- **An answer about the diagram is read on the diagram.** The brief asks the agent to mark every part
  it talks about with its id (`[[event_queue]]`). The bubble shows each as the part's name, a chip that
  lights the part on the canvas while hovered and brings it into view on a click. Each paragraph or
  bullet that names a part of the view gets a number, and the same number is pinned on that part
  (`PointPins.tsx`: a shape's top-left shoulder, beside a connector's label). Hovering a pin lights its
  point and parts, and the point lights its pin; clicking a pin opens the conversation at that point.
  Only the latest finished turn is pinned, never one with a proposal up (the change holds the canvas,
  so its points aren't numbered in the bubble either), and only while Nodi is open.
  The light is `uiStore.pointedIds`, transient like the jump flash; an id the view doesn't have points
  at nothing (`numberedBlocks`, `replyPoints` in `companion.ts`).
- **Nodi talks from rest, and only exists with an agent.** No pill of unlabelled buttons: a pixel
  speech bubble (notched outline, stepped tail, a NODI nameplate like a game's dialogue box) says the one
  thing worth knowing, typed out a letter at a time, and is the way in. A greeting or a selection line
  pops up on arrival and on hover; work under way, a waiting change or an unread answer stays up until it
  isn't true (`nodiLines.ts`: lines are data, a new greeting each hover, one news line per run, a
  repertoire of production one-liners). On a diagram's first opening each app run Nodi walks on from the
  canvas edge (a `walking` mood with alternating strides), then greets. The agent list is asked at
  start: with no agent installed there is no Nodi at all.
- **Opened, the replies are offered.** The open bubble is the same dialogue box, carrying on the line,
  with three replies in the person's voice ("Walk me through it", "What breaks first?", and a wildcard
  such as "Roast my diagram"); each sends a plain question, so the joke never reaches the agent. The
  selection is the composer's chip, with × to ask about the whole view instead.
- **The mascot's bubble is the conversation.** It shows the step the agent is on, then the latest reply
  (paragraphs and lists, clamped); **Show the conversation** expands the same bubble into the whole
  exchange, so there is never a second pop-up.
- **Accept** is the panel's own commit (`useProposalReview`), one undo step; each surface clears only
  its own canvas preview. The proposal badge leaves a proposal the companion is showing to the companion.
- **Activity line** skips work tagged with a companion run. Turning agent access off stops every run.
- **The agent's brief** asks for advice before edits: a question gets an answer pinned to the parts
  it names and changes nothing (no note, no open point), with the change or open points offered. A
  change is sized to the request: a whole pattern when one is asked for (read, miss, fill and the
  write policy for cache-aside, with a flow and a policy note), one element and the relationships it
  needs when that is asked for, the rest of its pattern suggested in the reply; descriptions stay
  short. Facts are kept apart from assumptions, a change records the risks it notices as open points,
  and a waiting proposal is revised in place (`revises`) rather than replaced. It changes only what
  was asked: a tidy-up is the `arrange` op alone, and regrouping, recolouring or
  renaming is suggested in the reply, not done.
- Collaboration: a guest never gets the companion (`ui/Editor/companionGate.ts`); an edit that lands
  before Accept, local or remote, turns the proposal into a conflict. Selective undo of an accepted
  proposal is the existing `applyToFile` path and its existing tests; no new test was added for it.

### Follow-ups

- **Proposal history. Built.** A revise keeps the earlier version's summary in the proposal's
  `history` (up to ten, `Proposal::history_with_self`); the chip and the review panel fold them under
  the summary ("Version 3 · revised 2 times").
- **Semantic review.** A check that names what a pattern is missing (a cache with no write path, a queue
  with no dead-letter path) from the diagram's own semantics, for the agent and the person alike.
- **Pending proposal in the turn context. Built.** Each turn's context names the newest proposal from
  this diagram's conversations still waiting for review (`Waiting` in `companion/mod.rs`), found in the
  proposal store, so it survives a restart that lost the page's own note of it.

### Real runs (2026-10-24)

Both agents were run with the companion's own command lines, against the real connector pointed at an
empty agent folder (so its calls answer `APP_UNAVAILABLE` and no running app is touched).

- **Claude Code 2.1.295:** the flags are accepted; `init` lists no built-in tools and `draft-canvas` as
  `connected`. The CLI was signed out on this machine, so the run ended at sign-in: an
  `is_api_error_message` assistant message (`error: "authentication_failed"`) and a `result` with
  `subtype: "success"`, `is_error: true`. The parser now skips the error message and says how to sign
  in, once (recorded in `companion/fixtures/claude-signed-out.jsonl`).
- **Claude Code, signed in:** `init` offers only the 13 `mcp__draft-canvas__*` tools (no built-in
  ones); the tool call, its failed result, the streamed reply and an `end_turn` result read as the
  parser expects (recorded in `companion/fixtures/claude-real-turn.jsonl`). `total_cost_usd` is reported
  on a subscription too, which is why the card shows cost only for API-key sign-in. **Hooks:** a
  project `SessionStart` hook ran in a control turn and not in the companion's, so
  `--settings '{"disableAllHooks":true}'` holds over project settings, and command-line settings rank
  above user settings as well. A Claude Code started from inside another Claude Code session (a
  development build launched from one) inherits that session's variables and still worked.
- **Codex 0.163.0** (signed in with ChatGPT): `codex exec --json --ephemeral --skip-git-repo-check -C <work>
  -s read-only --disable shell_tool -c approval_policy="never" -c 'mcp_servers={draft-canvas={command=…,
  env={…}}}' -` loads only Draft Canvas (replacing the table keeps the person's other servers out),
  calls the tool and answers. Events, for Phase 6: `thread.started {thread_id}` (the resume key),
  `turn.started`, `item.completed {type: agent_message, text}`, `item.started`/`item.completed
  {type: mcp_tool_call, server, tool, arguments, result, error, status}` with a failed call as
  `status: "failed"` and its error in `result.structured_content`, then `turn.completed {usage}`. No
  cost is reported on a ChatGPT plan.
- **Found and fixed:** the connector finds its app through `agent.json` in a fixed folder, so a run
  started from any app but the installed one (a development or beta build) would have reached the
  wrong app. Each run's configuration now sets `DRAFT_CANVAS_AGENT_DIR` to the starting app's own.

### Phase 5: docs

[Desktop](../guides/desktop.md), [Connect an AI agent](../guides/connect-an-ai-agent.md),
[Agent integration](agent-integration.md) (a "Companion" section, the `run` field and policy),
[Privacy](privacy.md), changelog. Screenshots regenerated with `npx tsx e2e/docs-screenshots.ts`.

### Phase 6: Codex backend

**Built** (`src-tauri/src/companion/codex.rs`, `find_codex` in `agent/clients.rs`). Checked against
codex-cli 0.163.0 with real runs: `codex exec --json --skip-git-repo-check --ignore-rules --disable
shell_tool -c sandbox_mode="read-only" -c approval_policy="never" -c mcp_servers={…} -c
developer_instructions="…" -`, and `codex exec resume … <thread> -` for later turns, which carries no
`-C`/`-s` flags, so both use `-c` overrides and the run folder as the working directory. Sessions are
kept (no `--ephemeral`, which would leave nothing to resume). `codex login status` answers on stderr.
The brief as `developer_instructions` is followed (a real turn called the tool first and used
`[[id]]`), and a resumed turn remembered the last.

Planned: `find_codex()` modelled on `find_claude()`. To verify against the installed `codex-cli` (0.163.0)
before building: `codex exec --json -C <work> --skip-git-repo-check -s read-only --disable shell_tool`,
the MCP server set with `-c mcp_servers.draft-canvas.command=…` and its `env`, the JSONL events
(`thread.started`, `item.*`, `turn.completed`, `turn.failed`), and `codex exec resume <id>`. A
read-only sandbox limits writes, not reads, so turning the shell tool off is what keeps Codex to the
Draft Canvas tools.

### Later

- A native ACP backend for agents that speak it (Gemini CLI), using the same `RunEvent`s.
- **Also read the project folder** mode: read-only file tools in the project folder, project settings
  and hooks still excluded.
- **Continue in Terminal** that opens Terminal; until then the card copies `cd <work> && claude --resume <uuid>`.

## Settled decisions

Agreed on 2026-10-24, before building.

| Question | Decision | What it means for the build |
| --- | --- | --- |
| Proposal or direct by default? | **Proposal first.** **Apply directly** is a preference (`companion.apply`). | The broker refuses `update_diagram` for runs in proposal mode ([step 4](#how-a-prompt-travels)). |
| Quick drafts | **Ask to save first.** | No new path for agent edits. The card shows **Save to a folder first**, then **Allow agents in this folder** if needed. |
| Cost line | **Only with API-key sign-in.** | Shown when `claude auth status --json` reports an API-key `authMethod`; hidden on subscriptions. The cost comes from `result.total_cost_usd`. |
| Token count | **Always, per conversation.** | The person's own plan or key pays for every turn, and a subscription's limits follow tokens, so the line under the message box shows the conversation's running total of new tokens ("33k new tokens so far"), once: a per-turn line in the bubble as well only repeated it. A turn is many model calls, one per step, each resending the whole context (brief, tools, diagram, conversation); the cache serves that repeat at about a tenth of the price. Counting it in the headline made one turn read as 508k tokens when 14k were new, so new tokens (everything read and written, less the cached reads) are the number shown, and the tooltip says what the cached re-reads are: discounted, not free, and still counted toward a plan's usage. `RunEvent::Stopped.usage`; turns dropped past 20 still count; a new conversation starts over. |
| Transcripts | **Keep them and say where.** | No `--no-session-persistence`. The docs and the card's menu name the folder from `projectsDirectory` in `claude auth status --json`. |
| Sign-in from environment variables | **Document it** (default, not discussed). | A GUI app does not see `ANTHROPIC_API_KEY` from a shell profile. The docs say to sign in with `claude` or set the key where GUI apps see it. Importing the login shell's environment can come later. |

`claude auth status` is a hint, not a gate. Run from a sandbox it can report `loggedIn: false` for an
account that is signed in through the keychain, so a negative answer shows the sign-in line without
blocking **Send**; the run's own error is what counts.

## Risks

- **CLI output and flags change.** Fixture tests, ignoring unknown lines, and a minimum version.
- **First long-running child process.** Process groups, the request registry, quit and update hooks
  and the idle limit; Windows job objects need testing on Windows.
- **The person's own plugins still run** inside the agent; documented, not prevented.
- **Placement on small windows.** The collapse rules above; check at 1024 px wide.
- **Hidden windows.** Tool calls fail after about 5 s when the page is suspended on platforms without
  background support (see [Running while the window is hidden](agent-integration.md#running-while-the-window-is-hidden)).
