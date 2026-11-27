# Agent integration (MCP)

Draft Canvas Desktop lets a coding agent on the same computer draw and revise diagrams over the
[Model Context Protocol](https://modelcontextprotocol.io).

- The agent sends a semantic graph: elements, relationships, groups, flows and notes.
- Draft Canvas validates it, lays it out, and writes ordinary, editable content that is saved and undoable.
- Access is off until a person turns it on, is limited to folders they choose, and never uses the network.

Setup and everyday use are in [Connect an AI agent](../guides/connect-an-ai-agent.md). This page is
the contract: tools, receipts, limits, errors and security.

## Architecture

<!-- Drawn in Draft Canvas: docs/media/reference/agent-architecture.json, rendered by
     `npx tsx e2e/og-diagram.ts --request <that> --out <the png>` against a dev server. -->
![A coding agent calls draft-canvas-mcp over stdio; inside Draft Canvas Desktop, the sidecar forwards to the broker over a socket or named pipe, the broker runs the call in the editor page and reads and writes diagram files.](../media/reference/agent-architecture.png)

| Hop | Transport | Code |
| --- | --- | --- |
| Agent → sidecar | MCP JSON-RPC over stdio; logs on stderr | `draft-canvas-mcp` in `src-tauri/mcp/` (`rmcp` 3.4), bundled with the app |
| Sidecar → broker | Newline-delimited JSON over a user-only Unix socket (macOS) or named pipe (Windows) | `src-tauri/src/agent/` |
| Broker → page | Calls run in the editor page | `src/desktop/agent.ts` → `src/agent/` (worker) → editor store |

- **Sidecar.** Stateless; forwards each call and reconnects on the next one.
- **Broker.** Owns access, folder scope, the request ledger, file reads, deadlines and the commit gate.
- **Page.** Validation, layout and quality checks (`src/agent/`, `src/layout/`) share the canvas's
  shape, text and routing code, so results match the canvas. Heavy work runs in `src/agent/worker.ts`.
  The editor's Arrange and Tidy up use the same worker (`layoutPlan.ts`) and a deterministic work
  budget, never the clock; an agent request keeps its time limit.
- **One writer.** Edits to the open document go through the editor store and undo history. A new
  diagram is written by the shell with a create-only write, which never overwrites.
- **No agent data in files.** An agent-made diagram is an ordinary diagram, on the web and the desktop.
- **Versions.** The MCP version is what `rmcp` negotiates. A sidecar and app on different bridge
  versions answer `VERSION_MISMATCH`.

## Tools

Schemas live in `src/agent/schema.ts`. `npm run agent:schemas` regenerates the catalogs in
`src-tauri/mcp/` (`tools.json`, `entry-tools.json`, `planning-entry-tools.json`, `run-tools.json`),
which the sidecar compiles in; `tests/agent/schema.test.ts` checks their contents and size budgets.

Discovery advertises one small dispatcher, `diagram_tool({tool, args})`, so a model turn does not
carry the whole grammar.

- `tool: "help", args: {}` lists this session's operations; `args: {tool: "update_diagram"}` returns
  that operation's common arguments: for `update_diagram`, every op and the fields `set` takes for
  each kind of target (generated from the same table the app checks an update against).
- A malformed dispatcher call is refused by the sidecar with the argument at fault: an operation's
  arguments sent beside `tool` instead of inside `args`, `args` sent as a string, or an operation
  name that does not exist (the refusal lists the ones that do).
- `get_capabilities({tool: "update_diagram"})`, dispatched the same way, returns its complete schema.
- Every request is still validated against the full contract (`contract: 3`).
- The dispatcher is annotated as mutating. The broker checks permissions, review-only restrictions and
  idempotency against the resolved operation, never the wrapper.
- A client that needs per-operation read/write annotations or tool allowlists can launch the sidecar
  with `--full-tools`. Previously discovered operation names stay callable.

The operations below are passed as `tool`, with their arguments in `args`.

| Tool | Kind | Purpose |
| --- | --- | --- |
| `get_capabilities({tool?, topics?, starter?})` | read | `tool` alone returns that tool's complete input schema. Otherwise vocabulary and rules: an index of topics and common word lists, each topic in full on request (`types`, `relationships`, `c4`, `flows`, `notes`, `sequences`, `starters`, `limits`, `layout`, `readability`). `starters` lists only what the person downloaded from the [starters gallery](../guides/examples.md). |
| `list_diagrams({query?, project?, cursor?, limit?})` | read | Diagrams in allowed folders, plus `active` (the open one) and `thisSession` (ones this session changed). |
| `read_diagram({diagramId, query?, view?, focus?, include?, outage?, cursor?, format?})` | read | One view, semantically. See [Reading](#reading). |
| `read_attachment({diagramId, expectedRevision, attachmentId, offset?, view?})` | read | Full note or code text in 8,192-character chunks. |
| `read_selection({diagramId})` | read | The current selection. See [Selection-aware editing](#selection-aware-editing). |
| `diagram_history({diagramId, action, revision?, against?, alternative?, name?, query?, limit?})` | read | The open diagram's history: summaries, revision lists, comparisons, restore and merge previews, milestone suggestions. Full reads only when the person allows them. See [Canvas Evolution](evolution.md#adr-13-diagram_history-a-reviewed-view-for-agents). |
| `get_implementation_context({diagramId, view?, focus?})` | read | Flow steps as stored, sequences (at most 8), notes, decisions, code and boundaries: what to implement, in order. Held to a read's 96 KB: notes are cut at 400 characters, a list that still doesn't fit is halved and named in `truncated`, and `more` says how to read the rest. |
| `render_diagram({diagramId, view?, format?, scale?, theme?, previewId?, focus?})` | read | PNG (`scale` 1–3, `light`/`dark`) or SVG from the export renderer, at most 8 MB. `focus`: `{nodes}`, `{group}`, `{flow}` or `{selection: true}`, with optional `neighbors`. |
| `create_diagram({requestId, title, nodes?, relationships?, groups?, flows?, notes?, sequences?, level?, starter?, layout?, project?, open?, allowDuplicateTitle?, fallbackType?})` | write | A new file. A title in use is `DUPLICATE_TITLE` unless `allowDuplicateTitle`. `fallbackType` draws unknown types as that type. `starter` begins from a downloaded gallery starter; its elements keep the file's ids under `starter.prefix`, in every view, and an id of the request's own that one of them has is `DUPLICATE_ID`. The receipt counts free notes in `created.notes` and attached notes and code in `created.attachments`, across every inside view. |
| `update_diagram({requestId, diagramId, expectedRevision, ops?, view?, scope?, layout?, activate?, onConflict?, previewId?})` | write | Every follow-up. See [Changing a diagram](#changing-a-diagram). |
| `preview_diagram({diagramId, expectedRevision, ops, view?, layout?, scope?})` | read | An unsaved candidate: `previewId`, diff and quality. |
| `submit_proposal({requestId, diagramId, expectedRevision, summary, ops?, rationale?, assumptions?, openQuestions?, view?, layout?, scope?, sourceRef?, revises?})` | write | Changes for a person to review. See [Proposals](#proposals-review-before-applying). |
| `get_proposal({proposalId})` | read | Status, counts and `stale`. |
| `list_proposals({diagramId?, cursor?, limit?})` | read | Proposals, newest first. |

`rename_element({diagramId, requestId, from, to, view?})` is a one-call shortcut for an exact-label rename:
no read and no schema lookup.

- Labels match exactly, including case, across architecture shapes and boundaries in every room.
  `view: {inside: [ids]}` restricts it to one room; `scope` keeps selection limits.
- A missing or duplicate label refuses without changing anything.
- The app resolves the id and revision locally, then uses the normal validated update, approval,
  revision, save and undo path. The request is journaled before resolution, so an identical retry
  replays its receipt even after the old label is gone.
- The compact receipt keeps durability, revision, undo, warnings and recovery instructions.
- When the person asked for review before application, use a proposal instead.

General rules:

- Write tools are idempotent by `requestId` ([Retries](#retries-and-the-request-ledger)).
- A tool failure is a result with `isError: true` and a stable `code`. JSON-RPC errors mean a malformed request.
- New ids match `^[A-Za-z][A-Za-z0-9_.-]{0,63}$` and become native ids. Existing ids, such as `n_…`, are used as they are.

### Reading

`read_diagram` returns elements with their C4 `role` and `scope`, relationships by endpoint, and notes,
attachments and flows with their ids. Elements, boundaries, notes, relationships and flows carry the
`color` they were given, in the form an update takes.

- `role` and `scope` are derived from type, level and boundary, never stored. A role of `unspecified`
  also carries `basis`, saying why.
- Empty values are left out (no `insideViews` when none has one, no geometry `pins` when both ends
  are automatic). Display geometry is rounded to hundredths.
- Pages hold at most 200 elements, 400 relationships, 20 flows, 50 open points and 96 KB. A `cursor`
  is bound to the revision and read options; a change answers `CURSOR_STALE`.

| Option | Effect |
| --- | --- |
| `view.inside: [ids…]` | A nested view. A service or component with none reads as empty. |
| `focus` | Elements, a group or a flow. Adds `partial: true` and the relationships crossing the edge. |
| `include: ["geometry"]` | Boxes, and relationship `geometry: {from, to, path, pins?, via?}`: the numbers `place` and `route` take. |
| `include: ["attachments"]` / `["fullText"]` | Attachment previews, or complete text. |
| `include: ["suggestions"]` | Up to 5 next-step suggestions per element. Never applied. |
| `include: ["views"]` | An outline of every inside view. |
| `outage: {element, allInstances?}` | What the drawing says follows if that element or group goes down: `headline`, `affected` (id and state), `unaffected`, `notes` (an open question carrying `open`, a quoted product behaviour its `sources`) and `flows` (each flow's `state`, and the `step` it breaks at). First page only. |
| `outage: {connector}` | The same for a relationship taken down while both of its ends stay up. |
| `outage: {}` | Every element, group and relationship whose loss changes something drawn: `review` and `connectors` (each with `reaches`, `flows`, `affected`, `open` and a sentence), `oneInstanceOfSeveral` and `nothingElseChanges`. An order, not a severity. |
| `format: "outline"` | File title and revision, plus paths, owners, levels and counts for up to 100 inside views (`viewsTruncated` marks a longer outline). |
| `format: "mermaid"` / `"plantuml"` / `"c4"` | Flows as sequence-diagram source, or the architecture as C4-PlantUML, as Export writes them. |

`outline` and the source formats cover the file and ignore `view`, `focus`, `include` and `cursor`.
Use the outline to find a room, then read it with `view.inside`; for a known group, flow or set of
nodes, pass `focus` directly.

**Search.** For a named edit beyond an exact-label rename, `read_diagram({diagramId, query: "name"})`
matches ids and labels (case-insensitive substring) across every room: shapes, free notes, groups,
relationships and flows, not attachment bodies or ink. It returns at most 20 matches with ids, types,
labels and `view.inside` paths, plus the file revision. `total` counts all matches, `truncated` means
refine the query, and labels over 200 characters have `labelTruncated: true`. Do not combine `query`
with other read options. Resolve ambiguity before editing; then send
`ops: [{op: "update", id, set: {label: "New name"}}]` with the match's view and revision. The receipt
verifies the change without another read.

#### Semantic review

The first page of a read also carries `review`: up to 8 findings, most important first, about what a
pattern in the view is missing, read from the diagram's own semantics (`src/agent/review.ts`). Each is
`{code, ids, message}`; a focused read keeps the findings about its focus.

```json
"review": [
  { "code": "no-dead-letter", "ids": ["q1", "w1"],
    "message": "Queue \"Orders\" has a consumer (\"Billing Worker\") but no dead-letter path: a message that keeps failing has nowhere to go." }
]
```

| `code` | When |
| --- | --- |
| `call-cycle` | Two services (or components) call each other with plain calls. A callback, event or async reply is not a call. |
| `shared-database` | Two or more services, workers or schedulers write (`writes`, `readsWrites`) the same database. |
| `no-consumer` | A queue, topic or stream receives messages and nothing consumes them. |
| `no-dead-letter` | A queue with consumers has no dead-letter path, its own or a consumer's; or a stream consumer has nowhere to park a record. Topics never get this. |
| `dead-letter-source` | A dead-letter queue is fed by something other than the queue whose messages it parks: a topic, a stream, or a consumer that writes to it itself. Names the queue to dead-letter from, or the consumer queue to add between a topic and its subscriber. A stream consumer parking a record is not flagged. |
| `no-producer` | A queue, topic or stream is consumed and nothing in the view sends to it. Not in inside views. |
| `cache-not-written` | A cache is read and nothing writes, refreshes or invalidates it. |
| `unconnected` | Shapes with no connections, in a view that has connections. Not in inside views. |

A finding needs the model to say it. A connector's semantic counts when it was chosen, or inferred on
a connector with no label (the canvas then shows that word). A connector that can't be read this way,
or a junction or boundary at a part, silences findings about something absent there. A context-level
view gets no messaging or cache findings. Findings are facts to raise with the person, not changes to
make: a missing dead-letter path belongs in the diagram only if the system has one.

`create_diagram`'s receipt carries `review` for every view (an inside view's findings name it in
`view`). An update or preview adds the findings the change brought in to its advisories, as
`Review (<code>): <message>`.

## Changing a diagram

`update_diagram` runs its ops in order as one change and one undo step, whether or not the diagram is open.

| Op | Does |
| --- | --- |
| `{op:"add", nodes?, relationships?, groups?, flows?, notes?, sequences?, openPoints?}` | Adds content beside what it connects to. |
| `{op:"update", id, set:{…}}` | Edits anything by id. Omitted fields stay; `null` clears an optional field. |
| `{op:"remove", ids, cascade?}` | Removes. A non-empty group needs `cascade`. |
| `{op:"setLevel", level}` | Sets the view's C4 level. `null` makes it a non-C4 view, also an inside view that would otherwise inherit one. |
| `{op:"arrange", …}` | Re-lays out in place. See [Arrange](#arrange). |
| `{op:"moveInside", owner, ids}` / `{op:"moveOutside", ids}` | One C4 level down or up. See [C4 support](#c4-support). |

- `view.inside` names the view to change. The first `add` inside a service or component creates its inside view.
- Existing elements never move except by `arrange` or `set.place`. Boundaries grow to hold new members.
- As in the editor, one ordinary relationship runs each way between two elements. A second, added or
  re-pointed, is `UNSUPPORTED` (a `compensates` action may sit beside its step). A `set.kind` the
  pairing doesn't offer is `UNSUPPORTED`; on a new relationship it is left out with an advisory.
- Boundaries and notes take `color` when added, as elements, relationships and flows do.
- If new content cannot fit, `LAYOUT_CONSTRAINED` carries `suggestedOp`, an `arrange` to add to the request.

**Previews.** `preview_diagram` makes a candidate with no file, history, recovery copy or proposal.
Render it with `render_diagram({diagramId, previewId})`, then apply it with
`update_diagram({requestId, diagramId, expectedRevision, previewId})`. Candidates last 10 minutes; at
most 4 (64 MB) are kept per page. A changed diagram refuses the candidate; panning and zooming do not count.

**Linked junctions.** A `junction` takes `link`, a name of up to 64 characters that the agent
chooses. Junctions with the same `link` are one continuation point drawn in several places, in one
view or across inside views, and people travel between them. Use a pair in place of a relationship
that would cross the whole diagram: end the line at one junction, start it again from another with
the same `link`, and give both the same short label.

- Create or add: `{id: "out", type: "junction", label: "A", link: "payment-handoff"}`.
- Link, move to another group, or unlink: `{op: "update", id, set: {link: "payment-handoff"}}`,
  `set: {link: null}`.
- `read_diagram` returns each junction's `link`, and `linkedJunctions: [{link, label, places:
  [{id, view}]}]` for every group with a member on the page: where each is drawn, by view path.
  `query` finds junctions by their link as well as their label.
- A group reads as one label, as it does for a person:
  - Junctions sharing a `link` in one create, or in the `add` ops of one update, need the same label
    (`INVALID_INPUT` otherwise).
  - `set.label` on any junction of a group renames every member, in every view. The receipt says
    how many others changed, and a review or proposal lists each with its view.
  - A junction joining an existing group (`add` with `link`, or `set.link` alone) takes the
    group's label, with an advisory when that replaced its own.
- `rename_element` renames a linked group by its label when no architecture shape carries that label.
- A link adds no relationship. Flows, semantics and outage reads follow drawn relationships only.
- `link` on any other element type is `UNSUPPORTED`.

**Source evidence.** Elements and relationships take up to 8 `evidence` entries:
`{path, basis: "observed" | "inferred", symbol?, commit?, line?, explanation?}`, with a
repository-relative `path`. They show under **Source evidence** in Details and are never fetched or checked.

## Selection-aware editing

An agent captures the selection once, then edits only those ids, even if the person selects something else.

1. `read_selection({diagramId})` reads the open diagram (`NOT_ACTIVE` if it is not open, a `null`
   selection if nothing is selected). Items have `role: "selected"` or `"context"` (up to 50
   neighbours). The ids come back as `selection: {path, nodes, edges}`. A selected sequence is
   reported under `sequences`, in full. The read is held to 96 KB as `get_implementation_context`
   is; `selection` always keeps every selected id. A scope takes at most 300 shapes and 300
   relationships: a larger selection says so in `message`.
2. The agent passes them as `scope: {nodes, edges}` to `update_diagram`, `preview_diagram` or `submit_proposal`.

With `scope`, `add` is always allowed. An `update` or `remove` outside scope is `OUT_OF_SCOPE`, naming
the ids, and so is anything such a change would carry outside it, in any view: a connector's meaning
re-inferred for a retyped shape, a linked junction renamed with its group, a sequence participant
renamed with its shape, a connector or flow step removed with a shape. Only where something is drawn
may change past the scope: a boundary grows to hold a shape moved into it, and connectors are
re-anchored to a shape that moved. A scoped id that no longer exists is `SCOPE_TARGET_MISSING`.

## Proposals: review before applying

`submit_proposal` asks a person to **Accept** or **Reject** a batch of ops in the editor, for example a
pull request's architectural impact. It never applies anything. No MCP tool can resolve a proposal;
`no_tool_lets_an_agent_resolve_a_proposal` in `src-tauri/mcp/src/main.rs` guards that.

| Field | Rule |
| --- | --- |
| `ops` | Validated as `update_diagram` would. Nonempty operations that make no changes are refused as `INVALID_INPUT`. `ops: []` with a `summary` records "no architectural impact" (`informational`). |
| `rename` | `rename: {from, to}` instead of `ops`, with `summary` and optional `view`, `scope`, `revises`. It cannot be mixed with ops, layout or a caller revision. The page resolves it once and stores concrete ids, ops, base revision and preconditions; Accept never resolves the label again. |
| `revises` | Replaces a pending proposal in place. A resolved one is `PROPOSAL_CLOSED`; a revision that landed first is `PROPOSAL_CHANGED`. |
| `sourceRef` | A PR's url, title or commits, shown to the person. Never fetched. |

Submission captures preconditions: the before-state of everything the ops change, in every view.

- **Stale** (`stale: true`): the revision moved. Informational; a non-blocking banner.
- **Conflict**: something the proposal is about changed, found by comparing the preconditions with
  the live document. New work that a re-run would change or delete also conflicts. A successful dry
  run is not proof. **Accept** stays disabled until the agent revises.

**Review panel** (`src/desktop/ui/ProposalPanel.tsx`): summary, status, counts and the changes in the
diagram's words (`reviewRows.ts`). On the canvas the proposal is drawn solid with new and changed
parts in teal and the diagram stepped back; moved shapes are drawn on a tracing sheet, each trailing
back to where it stands now; removals are struck through. The preview clears on Accept, Reject,
Dismiss, close, or a proposal or document switch. A revised proposal lists its earlier versions
(`history`, up to ten). A decided proposal reads as a record, without actions.

**Accept** re-checks the proposal version and diagram revision inside the commit, then applies the
whole batch as one undo step through `applyToFile`. If the diagram is still the one the dry run
worked on, it commits that dry run's result, so what lands is what the diff showed; after an edit in
between, it works the proposal out again. **Reject** and **Dismiss** never touch the document.

**Crash recovery.** A proposal is recorded as `accepting` before its commit. After a crash, the panel's
dry run decides:

| Case | Dry run shows | Panel offers |
| --- | --- | --- |
| A | Never applied | **Accept** (retries) or **Dismiss** |
| B | Fails only because this proposal's own new ids exist with matching content (`looksAlreadyApplied` in `src/agent/proposal.ts`) | **Mark as applied** (no document write) or **Dismiss** |
| C | Anything else | **Dismiss**; never resolved automatically |

Proposals are stored in `agent/proposals.jsonl`; resolved ones are kept 30 days.

## Nodi, the desktop companion

Nodi (`src/desktop/ui/Companion.tsx`) runs the person's own agent CLI in the background, one turn at
a time, behind an ACP-shaped interface (`src-tauri/src/companion/`; events: started, message, tool
call, tool update, stopped). Each agent is a `Backend` (locate, sign-in, command, parser). The
person-facing description is in [Connect an AI agent](../guides/connect-an-ai-agent.md#ask-nodi-on-the-canvas).

| Agent | Command (prompt on stdin) | Kept to Draft Canvas by |
| --- | --- | --- |
| Claude Code 2.1.295+ | `claude -p --output-format stream-json`, `--resume` for later turns | `--tools ""`, `--strict-mcp-config` with only Draft Canvas, `--allowedTools mcp__draft-canvas__*`, hooks off |
| Codex 0.163.0+ | `codex exec --json`, `codex exec resume <thread>` for later turns | `--ignore-user-config`, tool-providing features off, read-only sandbox, approvals off, only the run's Draft Canvas server configured |

- Codex starts only after its feature listing can be verified; an unreadable probe refuses the run
  rather than dropping restrictions. CLI probes have deadlines.
- Codex merges MCP tables from configuration overrides, so runs pass `--ignore-user-config` and keep
  only the person's `CODEX_HOME` for authentication and sessions. Custom models, providers and
  credential-store settings do not carry into Nodi; externally connected agents keep their own.
- Codex runs with every feature that brings its own tools turned off (browser, computer use, image
  generation, sub-agents, plugins, apps, skill search, `unified_exec`: only those `codex features list`
  reports), web search off, skill instructions omitted and multi-agent tools removed. Planning mode
  and the structured-question tool are disabled, so Nodi asks clarifying questions in chat. The exact
  overrides are in `src-tauri/src/companion/codex.rs`.
- Codex reports cumulative token counters when resumed; the app reports only the turn's increase and
  leaves usage unknown without a baseline.
- Each run is killed as a whole process tree (a process group on Unix, a Job Object on Windows) on
  Stop, on an output limit and when the app exits.
- Claude Code keeps its own session transcripts (no `--no-session-persistence`); the folder is
  `projectsDirectory` in `claude auth status --json`. That command is a hint, not a gate: it can
  report `loggedIn: false` for a keychain sign-in, so a negative answer shows the sign-in line
  without blocking **Send**. The person's own plugins still run inside the agent; that is documented,
  not prevented.

The brief (`BRIEF`) is the agent's whole system prompt, replacing its coding one (`--system-prompt`;
Codex's `model_instructions_file`, the run folder's `brief.md`). Each turn's prompt starts with a
`<draft-canvas-context>` block: diagram, view, selection, which tool makes changes, a proposal of this
conversation still waiting for review, and on a follow-up whether the diagram is unchanged since the
last turn. The page attaches no diagram snapshot; the agent reads what it needs, and an "unchanged"
hint permits reuse only of views it actually read. Each run's connector carries `DRAFT_CANVAS_RUN`
(the run id) and `DRAFT_CANVAS_AGENT_DIR` (the app's agent folder).

**Run policy** (`agent/runs.rs`). The bridge holds a run's calls to:

- **Only the diagram the person asked about.** `list_diagrams`, `create_diagram` and any other
  diagram id are refused (`RUN_LIMIT`).
- **`update_diagram` only in Apply changes directly mode.** Otherwise `PROPOSAL_ONLY`, and the agent
  submits a proposal tagged with its `run`.
- **Stopping the run, or turning agent access off, ends it.** Calls not yet committed fail with
  `CANCELLED`. A terminal event from the agent closes the same authority at once, even if its process
  has not exited. A Stop during process startup is remembered and applied when the process appears.
- **The project's code only when the person allowed it.** Without that, the run is offered
  `ask_to_read_code`, which the app answers itself ("end your turn"); Nodi then asks in chat. With it
  (`DRAFT_CANVAS_CODE=1`), the run is offered `list_code`, `search_code` and `read_code`, answered
  from one folder (`agent/code.rs`): canonical paths inside it only, no symlinks out, no `.git`,
  dependency or build folders, nothing the root `.gitignore` ignores with `*` and `**` patterns (lines
  using `?`, character classes, escapes or negation are skipped, and matching is case-sensitive), no
  secrets (`.env`, keys, credentials, Terraform state, kubeconfig, registry logins), no binaries,
  bounded results. The folder
  is the one chosen for the diagram, else the repository it is saved in, else its own folder; "Always"
  is kept in settings (`codeFolders`), "Just for now" until the app quits. These tools are in
  `RUN_TOOLS` (`src/agent/schema.ts`, generated into `run-tools.json`); a connected agent is never
  offered them (`UNKNOWN_TOOL`).

**Token budget.** Every model call resends the agent's instructions and tools, so both are small and
calls are few.

- **No local intent classifier.** Turns start with identity, room, selection and review mode. The
  agent interprets the request and returns a structured final decision: a chat answer, an exact-label
  rename, an ordinary update or a proposal. Reads, help and previews stay available while it plans;
  the run policy refuses mutations in this phase, including through legacy tool names.
- **Host-executed edit.** Only after a successful model turn and a clean process exit does the host
  authorize the exact final payload and launch the bundled executor. It pins diagram id, request id
  and the submitted selection scope; review mode still requires a proposal (and routes a rename to
  `submit_proposal` with a bounded generated summary). The normal broker performs access checks,
  validation, ambiguity refusal, journaling, revision checks, cancellation, persistence and undo.
  No model runs afterwards to confirm it, which removes the post-edit confirmation inference.
- **Receipt-driven replies.** The receipt supplies the outcome: saved, unchanged, applied-but-unsaved,
  save-failed or awaiting review. A malformed decision, failed or cancelled run, denied edit or unknown
  receipt never produces a success message, and errors are not retried automatically. Recent outcomes
  go to the next turn as bounded, transient data (with the "unchanged" hint cleared), because the
  model's transcript holds its plan, not the plan's result. Token usage, including cached input,
  stays on the model turn.
- **One dispatcher, on-demand schemas.** A companion run can dispatch only its permitted operations,
  without `render_diagram` or `read_selection`. The brief tells the agent to reuse the supplied view,
  fetch single capability topics, compare alternatives with previews and take revisions and
  advisories from receipts.
- **Small talk costs nothing.** A whole message of only "hello", "thanks", "bye" or "how are you" is
  answered by Nodi (`nodiLines.ts`'s `smallTalkOf`): no run, no tokens. "Yes" and "ok" reach the agent.
- **Skills** (`/` in the box, `nodiSkills.ts`) are worked out from the view when the menu opens. Layout
  skills are the editor's own Arrange with an `ArrangePreset`, shown as a preview like every other way
  in (`commands/arrange.ts`) and applied as one undo step; `/tidy` and `/present` appear only when
  their ⌘K command or a playable flow exists; `/explain` and `/risks` go to the agent. A read-only
  diagram offers no layout. None of the local skills starts a run or spends tokens.

**State.** The agent's session id is kept per diagram and agent in `companion/sessions.json`; the
conversation shown is per agent and in memory only. Replies may name parts as `[[id]]`, which Nodi
shows by name and pins as numbered points. Run output is bounded independently of the model's
budget: passing the limit fails the run and closes its tool access. A reload recovers a run's recent
events in order without duplicating text, and the two latest completed turns stay until **New
conversation**. The page caps the turns and conversations it keeps, never evicting an active one
(limits in `src-tauri/src/companion/`).

## One diagram across a conversation

Agents create once, then send every follow-up ("add a queue", "rename it", "clean up the arrows") as
`update_diagram` on the same `diagramId`. Which diagram, in order:

1. An id the person named, or one from earlier in the conversation.
2. The diagram this conversation created or last changed (`list_diagrams.thisSession`, per sidecar process).
3. "The current diagram": `list_diagrams.active`.
4. A title: `list_diagrams({query})`. If several match, the agent asks.

A deleted or moved diagram is `NOT_FOUND`. A failed update never becomes a create.

## Revisions, persistence and undo

| Revision | Means |
| --- | --- |
| `o:<pageEpoch>.<revision>` | The open document. Changes on every edit, undo, redo and page reload. |
| `f:<16 hex digits of SHA-256>` | A file on disk. Also valid for the open document while it has no unsaved changes. Saved receipts carry this. |

`expectedRevision` is checked before the work and again inside the commit, so a person's edit in the
meantime is `REVISION_CONFLICT {currentRevision}`. With `onConflict: "rebase"`, the change applies to
the current revision when the person changed none of the same content.

| Receipt `state` | `persisted` | Meaning |
| --- | --- | --- |
| `saved` | `true` | No unsaved edits, so it was written to disk. |
| `applied-unsaved` | `false` | The person had unsaved edits; saving is theirs. The recovery copy covers it. |
| `save-failed` | `false` | Applied, but the write failed. **Do not send it again.** |
| `unchanged` | as before | Nothing changed. |

Receipts also carry counts, `where` (`editor` or `file`), `undo`, `quality`, `legibility` and up to 5
advisories (10 on create).

- **Closed diagrams** are changed in their file, only if it is unchanged since read
  (`REVISION_CONFLICT` otherwise). A pending recovery copy is `DOCUMENT_BUSY`. The person gets a
  notice with **Show**. `activate: true` opens the diagram once the change is written, unless the
  person is typing or has edited what is open by then; the notice offers it instead. It is refused
  (`DOCUMENT_BUSY`, nothing changed) when what is open has unsaved changes or is in a live session,
  and a rejected or cancelled request never switches what is on screen.
- **Undo.** One update is one undo step. For a closed file, the previous content is kept in memory
  (8 changes, 16 M characters) and becomes undoable if the file is opened unchanged this session.
  `create_diagram` has no undo step.
- **New diagrams** open when `open: true` and nothing would be lost, or when nothing else is open.
  Otherwise the receipt says `opened: false` and the person gets **Open**.
- **Busy editor.** A change waits up to 8 s for a drag, typing or presentation to end, then answers
  `BUSY` (retryable). Agents never steal focus.

## Retries and the request ledger

Write calls are keyed by `(tool, requestId)` in `agent/ledger.jsonl` in the app's data folder:
append-only, fsynced, mode 0600, compacted at start-up and every 500 records (a failed compaction is
retried later and never fails the triggering record). Guarantee: at most one application per
`requestId` while its entry is kept. Resolved entries are kept 7 days (at most 2,000); unresolved
ones 30 days.

| Retry with the same `requestId` | Answer |
| --- | --- |
| Same request, resolved | The stored receipt, `replayed: true`. Side effects are not repeated. |
| Different payload while the first request is running, unresolved or committed | `REQUEST_ID_MISMATCH`. |
| Same payload while the first request is running | Waits for its outcome. |
| First refused before any change | A retry or correction can use the same id. |
| Create interrupted before its receipt | If the file has the minted id, returns `recovered: true`. If the target is absent, the same request can run again. |
| Update interrupted before the commit gate | Runs again; nothing was applied. |
| Update interrupted after the gate or a file write could not be confirmed | `OUTCOME_UNKNOWN`. Read the diagram to check what landed. |
| Stored receipt said `persisted: false` | The receipt, with `durability: "unverified"`. |

| Deadline | Limit | Past it |
| --- | --- | --- |
| Local bridge write | 5 s | Connection closes and waiters are released |
| Sidecar call, including connection and queue waits | 120 s | `CONNECTION_LOST`; retry a write with the same `requestId` |
| Page acknowledges | 5 s | `APP_UNRESPONSIVE`, nothing applied |
| Page reaches the commit gate | 30 s | Refused, nothing applied |
| Receipt after the gate | 60 s | `OUTCOME_UNKNOWN` |

Cancellation counts only before the gate. It is remembered during connection setup, folder lookup and
between page requests, including before a prepared proposal is saved. A client disconnect is not a
cancel; turning access off still cancels work that has not passed the gate. Work already past its
gate finishes and keeps its receipt. Proposal storage releases the cancellation lock before disk I/O,
so a slow save cannot hold Stop or process termination.

## Layout and the quality gate

Layout is Draft Canvas's own deterministic layered layout (`src/layout/layered.ts`), sized by the shape
renderer and canvas text layout. Boundaries are laid out as clusters; cycles are broken for layering
only. Connectors use the editor's own routing. Main paths run straight; failure, retry and dead-letter
paths step off them; matching fans share a trunk.

**`layout` options:** `direction` (`right`, `down`), `spacing` (`compact`, `comfortable`, `spacious`),
`primaryFlow` (lay out one flow as the main path), `allowDegraded`, `normalizePeerSizes` (one size for
peer shapes; on for new content, off for `arrange`) and `viewport: [width, height]` (prefer layouts
readable at that size; refuse if none is).

**Quality gate** (`src/agent/quality.ts`), checked on connectors as drawn:

| Class | Checks | On create | On update |
| --- | --- | --- | --- |
| Error | Overlapping shapes; a member outside its boundary; clipped text; a connector through a shape; a caption over a shape or another caption; a line through a caption; connectors overlapping for over 30 px; invalid geometry | Repaired, else `LAYOUT_FAILED`. `allowDegraded: true` keeps it with `degraded: true`. | Only touched content is judged. An error is `LAYOUT_CONSTRAINED`. |
| Warning | A lone connector between facing sides that still steps sideways | Reported | Reported |

Repair tries re-anchoring, roomier spacing, then the other direction. Where shapes one caller calls
also call each other, a second layering keeps them in one row; it is kept only when it reads better
and adds no crossing. An add into an empty view (a new inside view) is laid out like a new diagram's
room, around its first flow. Repair stops at a 6 s soft budget; a worker still busy at 20 s is ended.
Either way nothing changes. Large one-shot requests (about 50+ elements) are often degraded or
refused: build in steps or use inside views.

**Legibility** (`src/agent/legibility.ts`) ranks equal candidates and is reported per view:

| Measure | Counts |
| --- | --- |
| `crossings` | Connector crossings; `crossed` names the pairs (up to 8) |
| `bundled` | Connectors folded into a shared trunk (a credit) |
| `detours` | Connectors over 1.5× the distance between their shapes plus 200 px |
| `throughBoundaries` | Connectors through a boundary neither end is in |
| `farNotes` | Notes more than 160 px from their subject |
| `fill` | Shape area over the diagram's area |

**Proportion** (`src/agent/proportion.ts`) reports what reads badly although the lines are clean. It
never refuses or repairs a layout; its fields appear beside the legibility measures only when found,
and an update's advisories name the ones the edit touched, each with the op that fixes it:

| Field | Reports |
| --- | --- |
| `stackedNames` | Shapes whose name wraps into more than two lines where a wider box takes fewer |
| `hiddenCaptions` | Connectors whose label or caption is cut short or left out for lack of room |
| `heavyHeaders` | Boundaries whose header band is 45% or more of their height |
| `smallOverview` | The view fitted to a 1440×900 screen draws its smallest text under 8 px; `scale` says how small |

**Advisories** (`src/agent/advice.ts`) name what to change, with ops where possible: ungroup unrelated
external systems, move detail inside past 8 elements per boundary or 15 per view, give a note an
`about`, set a `primaryFlow` when there are many crossings or detours, or name a technology as its
product ("Spring Boot 3", not "Spring Boot modular monolith") so its logo shows. An `arrange` that
names a direction keeps it, and says so when the other direction reads clearly better.

### Arrange

`{op:"arrange", scope?, direction?, spacing?, connectors?, move?, primaryFlow?}` (`src/agent/arrange.ts`):

| Field | Values |
| --- | --- |
| `scope` | Whole view (default), `{group}` or `{nodes}`. Nothing outside moves. |
| `direction` | Overrides the request's `layout.direction`; defaults to the view's current direction when neither is given. |
| `connectors` | `tidy` (default) re-anchors and drops hand routes; `keep` keeps them; `orthogonal` also makes them right-angled. |
| `move` | `false` only re-anchors connectors. |

Ids, labels, attachments, note text and flows never change. To keep a shape fixed, leave it out of `scope`.
A shape the person holds in place (`held: true` in reads) stays where it is, with the boundary it is
in or what it holds; an advisory says so, also when that leaves nothing to arrange.

### Exact placement and routing

Coordinates are view px, as `include: ["geometry"]` reports them. For a single row or column, chain
`set.place` updates (`rightOf` with `align: "center"` for a row, `below` for a column);
`arrange.direction` only sets the graph's reading direction and can stack several nodes in a layer.

- **`place`** (on create, `add`, or `set.place`): `{x, y}`, or `{rightOf | leftOf | above | below: id,
  gap?, align?}`, plus `width`/`height`. Never smaller than the text needs. Groups move with their
  contents. An omitted `gap` uses an explicitly supplied `layout.spacing`, with room for captions
  between the shapes; without explicit spacing it is 48 px. A numeric `gap` always wins.
- **`route`** (on a relationship, or `set.route`): `{from?, to?, via?}`, with sides `top`, `right`,
  `bottom`, `left` and `via` as `[x, y]` bends, as in
  [Bend a connector by hand](../guides/shapes-and-connectors.md#bend-a-connector-by-hand).
  `set.route: null` makes it automatic.
- Overlaps, clipped text and shapes outside their boundary are still refused. Line and caption
  problems the request caused itself are warnings.

## Notes and flows

**Notes.** `kind` is `note` (default), `question`, `warning`, `decision`, `code` (`code`, `language`;
never run) or `label` (Markdown `text`, optional `style`: role, font, background, align, bold,
italic, colour).

| `about` | Becomes |
| --- | --- |
| An element | An attachment chip (a card beside it if it already has 12). With `attach: false`, a free card beside it. |
| A relationship | An attachment on the connector. Not for labels. |
| A group | A card at the head of the boundary; with `attach: true`, an attachment on it. |
| Omitted | A free card after the diagram, with an advisory. |

`set.attach` converts between attachment and free card, keeping the id.

**Flows** are named, ordered walks over existing relationships, used by the Flows panel, presentation
and sequence export.

- A step is a relationship id, `{relationship, caption?, highlight?}`, or `{spotlight: [ids], caption?}`.
- Updating `set.steps` keeps each surviving step's id, caption, highlights and camera. Reads return
  steps in the form an update takes.
- `pinnedView: false` drops a pinned camera. Agents cannot pin one.
- Duplicate titles are `DUPLICATE_FLOW`. A relationship appears once per flow.
- `variantOf` links a variant to a base flow; a variant of a variant is `INVALID_REFERENCE`.
- There is no stored "main" flow. Agents build flows only from an order the person or code gives.

## Sequences

A native [sequence](../guides/sequence-diagrams.md) is sent and read as a Mermaid `sequenceDiagram`
(`src/agent/sequences.ts`); the app parses it into its own model, lays it out and sizes it. As with
flows, build one only from an order the person or the code gives.

- `sequences: [{id, title?, mermaid, links?}]` on `create_diagram` and the `add` op. On create it is
  placed below the architecture; on add, where there is room. Nothing else moves.
- `links: {participantId: elementId}` makes a participant stand for an element of the same view: it
  takes that element's name, kind and technology and follows it. A participant written under an
  element's own id is linked without being listed. One participant per element; only a service,
  data store, queue, actor or component can be stood for.
- `read_diagram` returns `sequences: [{id, title, participants, messages, mermaid, links?}]`, apart
  from `elements`. Text over 6,000 characters is left out (`truncated: true`) unless `fullText` is
  included or the read is focused.
- `update` takes `set.title`, `set.mermaid` (replaces what it holds; participants still written under
  the ids a read gave keep their links), `set.links` (re-links; `null` unlinks all) and `set.place`.
  `remove` takes its id.
- What the text asks for that is not drawn (`autonumber`, `rect`, lost messages) comes back as a
  receipt advisory. Text that is not a sequence diagram is `INVALID_INPUT`.
- A shape an agent renames or retypes is renamed where it stands in a sequence, in the same change.

## Relationship options

Besides `label`, `semantic`, `kind`, direction, dashes and condition:

| Field | Value |
| --- | --- |
| `color` | An accent; `null` clears it. |
| `lineStyle` | `stepped` (default), `curved` or `straight`. |
| `response` | A synchronous call's reply line: `true`, a label, or `false`/`null` to remove. |
| `deliveryAttempts` | 1–50, on a `deadLetters` route. |
| `route` | See [Exact placement and routing](#exact-placement-and-routing). |

`set: {from?, to?}` re-points a relationship in place, like **Reverse direction**. Its id, label,
attachments and flow steps stay.

## Live progress and preview

- Requests under 300 ms show nothing. Longer ones show the stage above the status bar, with **Cancel**
  before the commit and **Show** for another diagram.
- Changes to the open diagram appear as a ghost layer, "Agent's proposed change"
  (`src/canvas/AgentPreviewLayer.tsx`). The person can keep editing; that turns the commit into `REVISION_CONFLICT`.
- New or closed diagrams appear on a "Not saved yet" sheet, with **Follow**, **Fit** and **Hide**.
- **Cancel** before the commit answers `CANCELLED`. After it, the line says *Applying…*; use Undo.
- Previews are never saved, undone or exported.
- With a `progressToken`, each stage goes to the agent as an MCP progress notification.

## C4 support

- **Levels** are the levels of Draft Canvas's views. Inside views nest at most 3 deep.
- **Inside views** exist only on services and non-port components (**Look inside**). Create one with
  `inside: {…}`, or the first `add` with `view.inside`.
- **`moveInside` / `moveOutside`** keep ids, attachments, evidence and internal connectors.
  Connectors across levels meet the owner. A flow moves only whole; a split flow, self-loop or merging
  connectors is refused.
- **Text.** Services, data stores, queues, actors and components take `description` (≤ 280) and `technology` (≤ 60).
- **Boundaries** are groups of kind `system`, `domain`, `network`, `deployment`, `group` or `boundary`, by `parentId`.
- **Relationship technology** goes in the label: "Makes API calls [JSON/HTTPS]".

**Role and scope are derived, never stored** (`src/depth/c4.ts`). Reads return `{role, scope}`, with `basis` when the role is `unspecified`.

| Element | Context | Container | Component | No level |
| --- | --- | --- | --- | --- |
| Actor: human, group | person | person | person | person |
| Actor: system, third party, AI agent | software-system | software-system | software-system | unspecified |
| Actor: device | unspecified | unspecified | unspecified | unspecified |
| Service: external system | software-system | software-system | software-system | unspecified |
| Service: other kinds | software-system | container | unspecified | unspecified |
| Data store, queue | unspecified | container | container | unspecified |
| Component (ports included) | unspecified | unspecified | component | unspecified |

Scope is `external` for external systems and system, third-party and AI agent actors; `internal` in a
`system` boundary or an inside view; otherwise `unspecified`. Mixed levels give advisories, not errors.

## Limits

Per request (`AGENT_LIMITS` in `src/agent/input.ts`). A breach is `LIMIT_EXCEEDED` with a JSON pointer.

| Limit | Value |
| --- | --- |
| Elements / relationships / groups | 300 / 600 / 60 |
| Flows / steps per flow | 20 / 60 |
| Extra elements / relationships one step lights | 40 / 40 |
| Notes / open points / ops | 60 / 50 / 100 |
| Sequences / sequence text | 8 / 20,000 characters |
| Attachments per element in a request | 4 |
| Label / relationship label / group label | 120 / 80 / 80 characters |
| Description / technology | 280 / 60 characters |
| Note / code | 1,000 / 4,000 characters |
| Flow title / step caption / reply label | 100 / 120 / 120 characters |
| Delivery attempts | 1–50 |
| Inside-view depth | 3 |
| Bridge frame | 4 MiB, at most 4 calls in flight per connection (the sidecar holds a fifth until one ends) |

Text is never truncated. A shape grows to 280 × 320 px; a name that still does not fit is `LIMIT_EXCEEDED`.

## Errors

Each error has a stable `code` and `message`, and where useful `hint`, `retryable`, a JSON pointer
`path` in `details` and up to 20 problems. Errors can identify diagram items and omit stack traces.

An input refusal leaves the diagram unchanged. A missing update target returns `INVALID_REFERENCE`
at its id, such as `/ops/0/id` or `/ops/1/ids/2`. If the exact id exists in another view, the message
gives that view. If the input matches one label in the addressed view, it can suggest the id.
For an existing target, an unsupported field names its kind and accepted fields. Value errors name
the field and what it accepts. A confirmed refusal allows a correction with the same `requestId`.

`retryable: true` means a transient failure may clear if the same request is sent again.
`OUTCOME_UNKNOWN` means the change might have landed. Check the diagram before sending another edit.

| Area | Codes |
| --- | --- |
| Input | `INVALID_INPUT`, `UNSUPPORTED_TYPE` (with the closest type words), `INVALID_REFERENCE`, `DUPLICATE_ID`, `CONTAINMENT_CYCLE`, `LIMIT_EXCEEDED`, `UNSUPPORTED`, `UNKNOWN_TOOL` |
| State | `REVISION_CONFLICT` (with `currentRevision`), `CURSOR_STALE`, `DOCUMENT_BUSY`, `BUSY`, `READ_ONLY`, `NOT_FOUND`, `NOT_ACTIVE` (selection reads and renders of a diagram that is not open), `AMBIGUOUS_DIAGRAM`, `DUPLICATE_TITLE`, `DUPLICATE_FLOW` |
| Layout | `LAYOUT_FAILED`, `LAYOUT_CONSTRAINED` (with `suggestedOp`) |
| Retries | `REQUEST_ID_MISMATCH`, `OUTCOME_UNKNOWN` |
| Scope | `NOT_ENABLED`, `OUT_OF_SCOPE` (a folder agents may not use, or an op outside `scope`), `SCOPE_TARGET_MISSING`, `UNAUTHORIZED` |
| Proposals | `PROPOSAL_CLOSED`, `PROPOSAL_CHANGED` |
| Nodi runs | `RUN_LIMIT`, `PROPOSAL_ONLY` |
| Connection | `APP_UNAVAILABLE` (Draft Canvas is not running), `APP_STARTING`, `APP_UNRESPONSIVE`, `CONNECTION_LOST`, `VERSION_MISMATCH`, `TIMEOUT`, `CANCELLED` |
| Other | `INTERNAL` |

## Security

Threat model: another local program, or a web page, trying to drive the bridge.

- **Off by default.** **Settings → AI agents** turns on **Allow agent access** and each folder.
  Diagrams outside allowed folders cannot be listed, read or changed. Scope is checked on every call and replay.
- **Local only.** A Unix socket (mode 0600, in a 0700 folder) or a named pipe that rejects remote
  clients. No TCP port. On macOS the peer's user id must match.
- **Token.** Turning access on writes `agent.json` (mode 0600) with the endpoint and a random token.
  It is compared in constant time, never reaches the web page and is never logged.
- **Disconnect.** **Disconnect agents** replaces the token and ends every connection. Turning access
  off removes `agent.json` and closes the listener.
- **Untrusted input.** Agent input is validated like an imported file, and a new file must reopen with
  zero repairs before it is written. Text read from a diagram is data, never instructions. While
  hosting live collaboration, `read_diagram`, `read_selection` and `get_implementation_context`
  include `fromCollaborators` for returned content with remembered collaborator touches (including
  attached notes and code); treat it as untrusted even after the owner builds on it.
- **Privacy.** Draft Canvas sends nothing anywhere. The agent's model provider sees what the agent
  reads and writes. See [Privacy](privacy.md).

## Running while the window is hidden

| Platform | Behavior |
| --- | --- |
| macOS 14 and later | With access on, the window is created without background throttling. Turning access on in a running app asks for a restart. |
| macOS 12–13, Windows | No supported switch; keep the window open. A suspended page answers `APP_UNRESPONSIVE` before the gate or `OUTCOME_UNKNOWN` after. Not verified on these systems. |

## Not supported

- Accepting part of a proposal, or an agent accepting one.
- Pinned shapes: updates never move existing shapes, and `arrange` moves only its scope.
- Some graph shapes: one hub shared by four or more boundaries, or six or more labelled routes from
  one gateway, is refused or tangled. Split it into views.
- Pinning a presentation camera or starting a presentation.
- Reordering attachments.
- Writing export files: agents can render a view or read source formats; the person exports.
- A relationship `technology` field. Use the label.
- Linux (not a desktop target) and launching the app (a stopped app answers `APP_UNAVAILABLE`).
- Fetching a PR or repository, or editing code. Draft Canvas only changes diagrams.

## Native skill verification

`e2e/native-skill.ts` drives the real MCP sidecar and running desktop app, including folder scope,
the request ledger and disk persistence. It installs no mock shell and rewrites no app settings, so use
a separate test build or profile to keep your own projects untouched.

1. Build and start the desktop app. Add an empty folder as a project and enable agent access for only
   that folder in **Settings → AI agents**. Keep the window visible.
2. From the repository root, run the create phase:

   ```bash
   npx tsx e2e/native-skill.ts --phase create \
     --sidecar <path-to-draft-canvas-mcp> --agent-dir <app-data-folder>/agent \
     --project-dir <enabled-empty-folder> --out <report-folder>
   ```

3. Quit the app, launch it again and open the saved diagram from Recent. Run the same command with
   `--phase verify` and the same folders.

The create phase checks that previews leave the real file untouched, exact retries do not write again
or duplicate, and stale revisions cannot change the disk. The verify phase compares the saved bytes
and all four views (flows, evidence, annotations, geometry) with the pre-restart snapshot. Both
render every view and save PNGs and JSON reports. Keep the report folder separate from the project,
and delete neither between phases.
