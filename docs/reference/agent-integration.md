# Agent integration (MCP)

Draft Canvas Desktop can let a coding agent on the same computer — Claude Code, Cursor, anything
that speaks the [Model Context Protocol](https://modelcontextprotocol.io) — draw and revise diagrams.
The agent sends a compact semantic graph: elements, relationships, groups, flows, notes. Draft Canvas
validates it, lays it out, and creates **ordinary, editable native content**, then persists it and
makes it undoable. The agent never supplies coordinates.

The agent does the reading of a codebase and the inferring. Draft Canvas does validation, layout,
rendering, persistence and undo. Access is off until a person turns it on, is limited to folders they
choose, and never involves a network.

For setting it up, see the guide [Connect an AI agent](../guides/connect-an-ai-agent.md). This page
is the design: what is guaranteed, where the boundaries are, and what is not supported.

## Contents

- [Architecture](#architecture)
- [Tools](#tools)
- [Selection-aware editing](#selection-aware-editing)
- [Proposals: review before applying](#proposals-review-before-applying)
- [One diagram across a conversation](#one-diagram-across-a-conversation)
- [Revisions, persistence and undo](#revisions-persistence-and-undo)
- [Retries and the request ledger](#retries-and-the-request-ledger)
- [Layout and the quality gate](#layout-and-the-quality-gate)
- [Notes and flows](#notes-and-flows)
- [Live progress and preview](#live-progress-and-preview)
- [C4 support](#c4-support)
- [Feature coverage](#feature-coverage)
- [Limits](#limits)
- [Errors](#errors)
- [Security](#security)
- [Running while the window is hidden](#running-while-the-window-is-hidden)
- [Document compatibility and releases](#document-compatibility-and-releases)
- [Performance](#performance)
- [Not supported, and why](#not-supported-and-why)

## Architecture

```
agent (MCP client)
  │  stdio: JSON-RPC; the protocol on stdout, sanitized logs on stderr
  ▼
draft-canvas-mcp            src-tauri/mcp/ — the sidecar, shipped inside the app bundle
  │  newline-delimited JSON over a user-only Unix socket (macOS) or named pipe (Windows)
  │  hello{bridge: 1, token, session} → welcome | refused; progress frames while a call works
  ▼
broker                      src-tauri/src/agent/ — in the running app
  │  access and folder scope, the request ledger, file reads, deadlines, the commit gate
  ▼
page                        src/desktop/agent.ts → src/agent/ (on a worker thread) → the editor store
```

- **One writer per document.** That is the running desktop app. An edit to the open document goes
  through the editor store and its undo history, the same as a manual edit. A new diagram is composed
  in the page, and then written by the shell as a new file (`create_new`, which never overwrites).
- **The sidecar is thin.** It speaks MCP (the `rmcp` Rust SDK), forwards each call over the bridge,
  and maps bridge failures to tool errors. It holds no state and reconnects lazily on each call, so a
  restart of the app is invisible to it except that revisions change.
- **The page does the diagram work.** Validation, layout and quality checks live in `src/agent/` and
  `src/layout/`. They are framework-free and depend only on `document/`, `depth/`, `edges/`, `nodes/`
  and `render/text/`, so the result is exactly what the canvas renders.
  - Heavy work runs in a module worker (`src/agent/worker.ts`) that measures text with its own
    OffscreenCanvas, and reports its stages and whole candidate arrangements as it goes (see
    [Live progress and preview](#live-progress-and-preview)).
  - Where a worker can't measure text (older WebKit without a 2D OffscreenCanvas), the page does the
    work itself, after yielding once.
  - The worker bundle must not touch `document` as it loads. One dependency did (the code
    highlighter's entity decoder), so in the packaged app every request ran on the main thread;
    `vite.config.ts` now gives the worker that package's DOM-free build, and
    `e2e/desktop/agent-activity.spec.ts` checks the worker is used.
- **Nothing about agents is in the file format.** An agent-made diagram is indistinguishable from a
  hand-made one.

The MCP protocol version is whatever `rmcp` 3.4 negotiates. The rmcp client negotiates 2025-11-25,
and a client asking for 2025-06-18 gets 2025-06-18. The bridge has its own version. A sidecar and app
that disagree answer `VERSION_MISMATCH` and point at Settings, which names the right sidecar.

## Tools

There are ten tools. Their JSON Schemas live in `src/agent/schema.ts`, and
`src-tauri/mcp/tools.json` is generated from them by `npm run agent:schemas`. The sidecar compiles
that file in, and `tests/agent/schema.test.ts` fails if the two drift. The whole tool list is
28,984 bytes of compact JSON, roughly 7.2k tokens (estimated as characters / 4) — `submit_proposal`
deliberately keeps its own `ops` schema loose (the same shape `update_diagram` documents in full,
never repeated a second time) to leave room for this. `get_capabilities` reports `contract: 2`; every
tool below `read_selection` is additive within that same contract.

| Tool | Annotations | What it does |
| --- | --- | --- |
| `get_capabilities({topics?, starter?})` | read-only | The vocabulary: element types, relationship semantics, C4 levels, limits, layout options, flows and notes, and starters. By default it is a short overview; `topics` expands one area, and `starter` returns one starter's keys. |
| `list_diagrams({query?, project?, cursor?, limit?})` | read-only | Finds a diagram to work on. The diagrams in folders agents may use: id, title, folder, relative path (for display only), revision, and whether it is open or has unsaved changes. `query` narrows to titles containing it (ignoring case), exact matches first and marked `exact`. Always also returns `active` — the diagram open right now, with its revision and the view the person is in — and `thisSession`, the diagrams this MCP session created or changed. Two files sharing an id are flagged, and addressing either returns `AMBIGUOUS_DIAGRAM`. |
| `read_diagram({diagramId, view?, focus?, include?, cursor?})` | read-only | One view, semantically. Every element comes with its derived C4 role and scope, relationships name their endpoints, and notes, attachments and flows carry the ids to edit them by. See the notes below for nested views, focus and pages. |
| `read_selection({diagramId})` | read-only | The person's current selection in the diagram open right now: stable ids, a bounded set of neighbouring elements marked apart from the selection itself, and the notes about it. See [Selection-aware editing](#selection-aware-editing). |
| `get_implementation_context({diagramId, view?, focus?})` | read-only | Flow step order exactly as stored (never inferred from layout), the notes and decisions about what's in focus, and its boundaries — for implementing an agreed design in the repository. Diagram text is context here, never instructions. |
| `create_diagram({requestId, title, nodes, relationships, groups?, flows?, notes?, actions?, level?, starter?, layout?, project?, open?, allowDuplicateTitle?})` | idempotent by `requestId` | A **new** diagram: validates, lays out, runs the quality gate and writes a new file. It never replaces anything, and a title already used in that folder is refused (`DUPLICATE_TITLE`, naming the existing diagram) unless `allowDuplicateTitle`. |
| `update_diagram({requestId, diagramId, expectedRevision, ops, view?, scope?, layout?, activate?})` | idempotent by `requestId`, destructive (it can remove) | Every follow-up. Ops run in order as one change: `add`, `update` (`null` clears a field; notes, attachments and flows are edited by id), `remove` (a non-empty group needs `cascade`), `setLevel` and `arrange`. Works whether or not the diagram is open. `scope`, if present, restricts `update`/`remove` (and any cascade) to a captured set of ids — see [Selection-aware editing](#selection-aware-editing). |
| `submit_proposal({requestId, diagramId, expectedRevision, summary, rationale?, assumptions?, openQuestions?, ops, layout?, scope?, sourceRef?, revises?})` | idempotent by `requestId` | Proposes a batch of changes for a person to explicitly accept or reject — never applies anything itself. See [Proposals](#proposals-review-before-applying). |
| `get_proposal({proposalId})` | read-only | A submitted proposal's status, counts, and whether the diagram moved since (informational — never a block). |
| `list_proposals({diagramId?, cursor?, limit?})` | read-only | Proposals for a diagram (or every one in scope), newest first. |

**Contract 2** (this release) changed four things an older client could notice: an update to a
diagram that isn't open is applied to its file instead of answering `NOT_ACTIVE`; a saved change's
receipt carries the file revision; a create with a title already in use is refused; and updating a
flow keeps its steps' ids. Everything else is additive.

Notes on `read_diagram`:

- A nested view appears as a reference, `inside: {level, elements, relationships}`. Read it with
  `view.inside: [ids…]`.
- `focus` narrows the read by elements, by a group or by a flow. A focused read says `partial: true`
  and lists the relationships that cross the edge of what it returned, naming the other end.
- `include` adds `geometry`, `attachments` or `suggestions`. `suggestions` returns up to 5 of Draft
  Canvas's own next-step suggestions per element; they are never applied automatically.
- Pages are at most 200 elements, 400 relationships and 96 KB. The `cursor` is bound to the revision,
  so a changed diagram answers `CURSOR_STALE`.

Every result is structured content plus a one-line text summary. Tool failures are results with
`isError: true` and a stable `code`. JSON-RPC errors are kept for malformed requests.

**Identifiers.** A *new* id an agent chooses must match `^[A-Za-z][A-Za-z0-9_.-]{0,63}$` and be unique
in the file; it becomes the native id itself. Existing ids are addressed as they are, including the
editor's own `n_…` ids and a starter's generated ids (`<prefix>.<key>`, `e1…`, `flow1…`).

## Selection-aware editing

"Add a retry path around this selection, and preserve everything else" needs the agent to capture
*which* elements that means once, then edit only those — even if the person changes what's selected
on screen while the agent is still working.

`read_selection({diagramId})` reads the diagram open right now (refused with `NOT_ACTIVE` if it isn't,
or with a `null` `selection` and a message if nothing is selected — never a guessed default scope).
Every returned element and relationship carries a `role`: `"selected"` for what was actually selected,
`"context"` for a bounded set of directly-touching neighbours shown for orientation only. The response
also includes the notes about the selection and the frozen ids themselves as `selection: {path, nodes,
edges}`.

Pass those same ids back as `scope: {nodes, edges}` on a following `update_diagram` (or
`submit_proposal`). With `scope` present: an `add` op is always allowed, including a new relationship
connecting a scoped element to one outside it (a legitimate boundary connection) — but an `update` or
`remove` targeting anything outside scope, or a cascade (removing a boundary with `cascade: true`)
that would reach outside it, is refused with `OUT_OF_SCOPE`, naming the ids it would have touched. A
scope id that no longer exists (deleted since `read_selection` captured it) is `SCOPE_TARGET_MISSING`.
Nothing about the *current* on-screen selection is consulted at commit time — only the ids captured.

## Proposals: review before applying

For a change the person didn't ask the agent to make directly — most often, the architectural impact
of a pull request the agent analysed on its own — `submit_proposal` hands Draft Canvas a bounded batch
of ops plus a rationale, for a person to explicitly Accept or Reject in the editor. It is never applied
by the call itself, and there is deliberately no tool that could accept one on a person's behalf: that
is a native, human-only action, enforced structurally (resolving a proposal is a Tauri command the
review panel calls directly; it is never registered as an MCP tool, so there is no wire path from the
sidecar to it at all — not merely an unadvertised one. `src-tauri/mcp/src/main.rs`'s
`no_tool_lets_an_agent_resolve_a_proposal` test guards this).

`submit_proposal({requestId, diagramId, expectedRevision, summary, rationale?, assumptions?,
openQuestions?, ops, layout?, scope?, sourceRef?, revises?})`:

- `ops: []` with a `summary` explaining why is a valid **no architectural impact** finding, not an
  error — it resolves immediately as `informational`, with no Accept/Reject to offer.
- `revises` names an existing *pending* proposal to overwrite in place (bumping its `version`) instead
  of creating a new one; revising one that has already been resolved is refused (`PROPOSAL_CLOSED`,
  naming its actual status).
- `ops` is validated exactly as `update_diagram` would — a bad proposal is refused at submit time, not
  discovered later at review — and a bounded "precondition" snapshot (the before-state of every id the
  ops touch) is captured for the review panel's conflict check.
- `layout` is the same object `update_diagram` takes at its own top level (`direction`, `spacing`,
  `normalizePeerSizes`, `viewport`) — one shared schema, so the two can't drift apart field by field.
- `sourceRef` (a PR's url/title/commits) is context for the person, never proof of correctness, and
  Draft Canvas never fetches it.

`get_proposal`/`list_proposals` report `stale: true` when the diagram's revision has moved since
submission — informational only; the review panel always re-diffs against the live document rather
than trusting either the submit-time snapshot or a successful replay as proof nothing conflicts. A
**conflict** (something the proposal is specifically about has changed — a renamed node, a moved
relationship) is different from staleness (something *unrelated* changed) and blocks Accept until the
agent revises the proposal; unrelated drift only shows a non-blocking banner.

Unlike `update_diagram`'s arrange (below), this dry run and the panel's own re-diff run on the page's
main thread, by design: they only run while the panel is actually open and being looked at, never
unattended, so there is no background request to protect the page from the way the worker protects one.

The review panel (`src/desktop/ui/ProposalPanel.tsx`) leads with the proposal's summary, a status pill
and accurate added/modified/removed counts, keeping rationale, assumptions and open questions
collapsed by default so the diff itself stays the main thing to read. Every reviewable proposal also
draws a ghost directly on the canvas (`src/canvas/AgentPreviewLayer.tsx`'s `ProposalPreviewLayer`,
the same ghost machinery — `GhostNode`/`GhostEdge` — the in-progress live-write preview uses):
additions and modifications as a dashed outline in place, removals (elements, connectors and
boundaries alike) crossed out where they stand, all through the ordinary node/edge renderer rather
than a second one. A "Show on canvas" toggle hides it without discarding it, a small legend explains
the two treatments, and "Focus changes" pans/zooms to exactly what the ghost is showing, clear of the
panel itself. The text list still carries the real before→after field values for a modification —
a proposal's whole point is often a non-geometric change (a label, a note, a relationship's meaning)
that a canvas ghost alone can't show — and a breadcrumb names which room the proposal targets when
that isn't the one currently on screen, including in the "no changes here" case.

Accept re-checks the proposal's version, the diagram's identity and revision one more time
immediately before committing (the revision check happens inside the same atomic commit call, not as
a separate step with a gap of its own), then applies the whole batch as **one** native undo step
through the same `applyToFile` primitive every other edit uses — undoing it afterwards never
reactivates the proposal, which stays `accepted`. Reject and Dismiss (clearing an old pending proposal
nobody reviewed) never touch the document; closing the panel, rejecting, dismissing, accepting, or
switching to a different proposal or diagram each independently clear the canvas ghost, so it can
never point at the wrong proposal or outlive its own review. A proposal accept interrupted by a crash
— durably recorded as `accepting` before the commit is attempted — is recovered the next time the
panel looks at it: if a dry run shows the change was never applied, it's offered for review again
unchanged (Accept retries it normally); if the same dry run's only obstacle is exactly the ids this
proposal's own `add` ops declared (`looksAlreadyApplied` in `src/agent/proposal.ts`), that's evidence
it already committed, and the panel offers "Mark as applied" — a plain status transition, no document
write — instead of Accept or Reject; anything else is left for a person to look at directly,
dismissible but never auto-resolved either way.

## One diagram across a conversation

The intended use is to create once, then edit in place:

| Person says | Agent calls |
| --- | --- |
| "Draw this architecture." | `create_diagram` — one call with the whole graph, notes and flows included. It keeps `diagramId` and `revision` from the receipt. |
| "Add a dead-letter queue and explain the retry behaviour in a note." | `update_diagram` on that `diagramId` with the last `revision`: `{op:"add", nodes, relationships, notes}`. |
| "Add a flow for the normal processing path." | `update_diagram`: `{op:"add", flows:[{id, title, steps}]}`, reusing the existing relationship ids. |
| "Rename the billing worker." | `update_diagram`: `{op:"update", id:"billing", set:{label}}`. |
| "Clean up the arrows and spacing." | `update_diagram`: `{op:"arrange"}`. |

**Which diagram.** The server instructions and tool descriptions give agents this order:

1. An id the person named, or one established earlier in the conversation.
2. Otherwise the diagram this conversation created or last changed. The agent keeps that id itself;
   `list_diagrams.thisSession` repeats it (the last 5 of this MCP session's diagrams) for an agent
   whose context was trimmed. That memory is per sidecar process — never shared between agents — and
   an app restart forgets it. An explicit id always wins.
3. "The current diagram" means `list_diagrams.active`: what is open in Draft Canvas right now, which may
   not be the diagram the conversation has been working on.
4. A title without an id: `list_diagrams({query})`. If more than one diagram fits, the agent asks the
   person which, in one short question, before changing anything. Draft Canvas never picks between
   duplicate titles.

A diagram that was deleted or moved out of the enabled folders answers `NOT_FOUND`, and the hint says
to ask the person rather than create a replacement. Draft Canvas never turns a failed update into a
create; the tool descriptions tell agents not to either.

**Why follow-ups used to create new diagrams.** Measured before this contract, a real client asked to
"clean up the arrows" made 8 calls in 52 s: it removed and re-added shapes (losing their ids), then
created a second diagram, because there was no way to re-arrange. Updates to a diagram that wasn't
open failed with `NOT_ACTIVE`, and a saved change's editor revision went stale as soon as the person
opened something else. All three are fixed: `arrange` exists, closed diagrams are updated in their
file, and saved receipts carry file revisions.

## Revisions, persistence and undo

**Revision tokens** are opaque strings.

- `o:<pageEpoch>.<revision>` is the open document. The store's revision rises on every change, undo
  and redo included, and a reload of the page changes the epoch.
- `f:<16 hex digits of SHA-256>` is a file as it is on disk. It is also accepted for the open
  document while that document has no unsaved changes. A receipt for a change that was saved carries
  this one, so it stays valid when the person opens another diagram, reopens this one, or restarts
  the app. Only a change left unsaved (`applied-unsaved`) carries an `o:` revision.

`update_diagram` compares `expectedRevision` twice: before working out the change, and again in the
same step as the commit. An edit the person makes while the change is being worked out therefore
becomes `REVISION_CONFLICT {currentRevision}`, never a silent overwrite.

**Save if clean.** After an agent edit is applied, the receipt's `state` is one of:

| `state` | `persisted` | Meaning |
| --- | --- | --- |
| `saved` | `true` | The document had no unsaved changes, so it was written to disk (a stamp-guarded atomic write that never shows a dialog). |
| `applied-unsaved` | `false` | The person had unsaved edits of their own, so saving is left to them. The change is in the editor, and the recovery copy covers it meanwhile. |
| `save-failed` | `false` | The change was applied, but the write failed (for example, the file changed on disk). `applied: true` is set, and the text says the change is in the editor. **Do not send it again.** |
| `unchanged` | as before | The ops changed nothing. |

Receipts are compact: `diagramId`, `title`, `revision`, `state`, `persisted`, the counts (`added`,
`updated`, `removed`, `arranged`), `view` when the change was inside a nested view, `where` (`editor`
or `file`), `undo` (`editor`, `on-open` or none) and at most 5 advisories.

**A diagram that isn't open** is changed in its file. What the person is looking at is never switched
for it. The page works the change out from the file's text, and the shell writes it only if the file
is still exactly as it read it (a stamp-guarded atomic write), so an edit made on disk meanwhile is
`REVISION_CONFLICT`, never overwritten. A file with a recovery copy pending — unsaved work from an
earlier session — answers `DOCUMENT_BUSY` instead. The person sees a notice, "An AI agent updated
*title*", with **Show**.

`activate: true` still opens the diagram first, as before contract 2. It opens only if the open
document has no unsaved changes and no pending recovery copy (otherwise `DOCUMENT_BUSY`), never
focuses the window, and shows a notice.

**Undo.** One `update_diagram` is one undo step. For the open document the step goes into its
in-memory history as usual. For a change written to a closed file, the page keeps what the file held
before, in memory for this session (at most 8 changes, 16 M characters in all). When that file is
next opened — from the notice or anywhere else — while it is still exactly as the agent left it, it
opens with the change as one undo step. Restarting the app forgets those, as it forgets any history.
`create_diagram` writes a new file and has no undo step: to undo it, delete the file.

**Opening a new diagram.** With `open: true` the new file opens when that would lose nothing. It also
opens by itself when nothing else is open (Home, or an untouched Quick Draft), because the person
watched it being made there (see [Live progress and preview](#live-progress-and-preview)). Otherwise
the receipt says `opened: false` and the person gets a notice with **Open**.

**Busy editor.** A change to the open document waits up to 8 s for a drag or typing to end. Past
that, or while presenting, it answers `BUSY` (retryable), with nothing changed. Nothing an agent does
steals focus.

## Retries and the request ledger

Every `create_diagram` and `update_diagram` carries a `requestId`. The broker keeps a ledger in
`agent/ledger.jsonl` in the app's data folder:

- The file is an append-only JSON-lines journal, mode 0600.
- Every record is `fsync`ed.
- It is compacted by an atomic rewrite (temp file, fsync, rename) at start-up and every 500 records.
- A torn last line is ignored on load.

The key is `(tool, requestId)`, and the value includes a SHA-256 fingerprint of the canonical request
(sorted keys, `requestId` excluded). Authentication and a *current* folder-scope check run before any
replay, so a replay can't reach a folder that has since been switched off.

- Same key, same fingerprint, resolved: the stored receipt is returned with `replayed: true`. Side
  effects the first answer described, such as opening the file, are **not** repeated.
- Same key, different fingerprint: `REQUEST_ID_MISMATCH`. The key isn't per session (a retry after a
  reconnect must still find its first answer), so the schema asks for a fresh UUID per change.
- A duplicate arriving while the first is still running waits for the first one's outcome.
- A request refused before anything changed is recorded as failed, and may run again under the same
  id.

**Crash boundaries.** Each stage is on disk before the step that follows it.

| Tool | The app stopped… | A retry with the same `requestId` answers |
| --- | --- | --- |
| create | before the page finished composing (`pending`) | The request runs again, unless a file carrying the diagram id minted for this request is found in scope; then that file's receipt is reconstructed (`recovered: true`). |
| create | after composing, around the write (`committing`) | As above. The minted id is random and used only by this request, so finding it in scope is evidence the write happened. The receipt then carries the file's *current* revision, since it may have been edited since. |
| create | after the receipt (`committed`) | The stored receipt, `replayed: true`. |
| update | before the commit gate (`pending`) | The request runs again. Nothing was applied, because a change is only ever made after the gate. |
| update | after the gate, before the receipt (`committing`) | `OUTCOME_UNKNOWN`. The change may or may not be in the editor or its recovery copy. Call `read_diagram` and decide; Draft Canvas doesn't guess. |
| update | after the receipt | The stored receipt. A receipt that said `persisted: false` comes back with `durability: "unverified"`: after a restart, the ledger can't know whether the recovery copy was restored. |

**Late pages.** The page must acknowledge a request within 5 s (`APP_UNRESPONSIVE` otherwise, with
nothing applied), and pass the commit gate within 30 s. The gate atomically moves the request from
*live* to *committing*, and refuses once the request has expired or been cancelled. A page resumed
after a timeout therefore can't commit an expired request. After the gate, the broker waits up to
60 s for the receipt, and answers `OUTCOME_UNKNOWN` past that. `notifications/cancelled` is honoured
only before the gate.

**Retention.** Resolved entries are kept for 7 days, and at most 2,000 of them (the oldest are
evicted first). Unresolved entries are kept 30 days; a replay after that answers `OUTCOME_UNKNOWN`.

**The guarantee.** At most one application per `requestId` while its ledger entry is retained. There
is no exactly-once claim beyond that.

`src-tauri/src/agent/ledger.rs` and `broker.rs` test torn lines, eviction, the cap, a lost response
after a save, a replayed unsaved receipt, and a late page refused at the gate.

## Layout and the quality gate

The layout is Draft Canvas's own deterministic layered layout (`src/layout/layered.ts`; no
dependency). It works in these steps:

1. **Clusters.** Boundaries are laid out as compound clusters, inside out. A boundary knows which of
   its shapes connect outside it: a shape whose only way on leaves the boundary goes to the boundary's
   far side, next to where its connector is headed, and one entered from outside goes first. Outside,
   a connector to or from a boundary lines up with the shape inside that it really joins, not the
   boundary's middle — so an external system sits level with the service that calls it. Loose shapes
   in a boundary that are each called from outside (a boundary of external systems) stand in a
   column, each level with its own caller, rather than in a row along the flow. A shape outside a
   boundary whose only connector joins something in the *middle* of that boundary's flow — an
   external system a hub calls, with more of the hub's own flow after it — is a **satellite**: put
   after the boundary, its connector would cross everything that follows its caller, so it hangs
   across the flow instead (below, reading right; to the right, reading down), level with its
   caller, as part of the boundary's block; the caller is moved to that edge of its layer, so the
   connector between them is a short straight line. Several satellites of one caller form a row
   under it. One joined to the last shape of the boundary's flow stays after the boundary, in the flow.
2. **Cycles.** They are broken for layering only. The stored `source` and `target`, semantics and
   flow steps are never touched, and a return is drawn as a detour that barely pulls on placement.
3. **Layers.** Longest-path layering, with placeholders for long edges.
4. **Order.** Crossings are reduced with barycenter sweeps and transposition.
5. **Positions.** A weighted least-squares placement (pool-adjacent-violators).
6. **Captions.** Gaps are wide enough for the connectors' captions.

Sizes come from the renderer: `naturalArchitectureSize` asks the shape describer itself. A caption's
size comes from the canvas's own text layout.

**Peer sizing.** Shapes of the same type, sub-kind (`serviceKind`, `actorKind`, …) and parent, and at
roughly the same distance along the graph, are given one shared size — so a row of actors or external
systems reads as a row instead of whatever each one's own content happened to need. A member far
larger than its group's typical size is left at its own size instead of being folded in, so one long
description never enlarges its siblings; nothing ever shrinks below the size it already has.
`layout.normalizePeerSizes` controls it — on by default for `create_diagram` and a newly-added block
(nothing manual to preserve yet), off by default for `arrange` on an existing diagram (which keeps
whatever sizes it already has unless this is explicitly asked for).

**Straight before balanced.** When two neighbours pull a shape equally, it lines up with one of them —
the one on the longer chain — instead of sitting halfway, where both connectors would step. A final
pass moves a shape by up to 72 px when that straightens a connector without overlapping anything,
leaving its boundary, or skewing another connector at that shape.

**Connectors.** Generated connectors use the editor's own right-angled routing (`smoothstep`) with
automatic anchors, the same default a hand-drawn connector gets; nothing about existing diagrams or
manual defaults changed. Straight lines come from placement, not from a straight-line style (which
would cut diagonally through shapes). Anchors follow the reading direction:

- Connectors sharing a side spread over its three handles in the order of their other ends.
- An unlabelled fan that all means one thing (a topic fanning out to its queues) leaves from a single
  handle, so the native router draws one trunk with one caption instead of parallel lines each
  repeating it.
- A **side path** — a `failure` or `retry` connector, or one into a dead-letter queue — pulls less on
  placement, so the main path is the one drawn straight and the side path steps off it.
- A **loop companion** — a shape joined to exactly one other by connectors both ways, such as a retry
  queue and its worker — sits right beside its partner across the flow, and the pair are given one
  width so the two connectors run as a short straight pair instead of a detour around the diagram.
- A return runs around the outside; when its caption or line meets another connector, the repair
  first tries moving *the other* connector, so a straight one isn't sent on a detour.
- **Labelled fans share a trunk.** Three or more labelled connectors leaving one shape (or reaching
  one) that mean the same thing — same semantic, kind, direction, async, accent — leave from one
  point, so Smart Routing draws one trunk with a labelled branch each; the layout keeps the gap wide
  enough for a caption on every branch after the trunk. The main path never joins one, a fan the
  router would refuse (its far ends stacked, its corridor blocked) is never started, and two
  branches' own captions are still checked against each other. Each such arrangement is judged
  beside the same one without the trunk, and the more legible kept.
- A connector cutting through a boundary neither of its ends is in (or along its title) is
  re-anchored when another anchoring avoids it without a much longer route (at most 320 px more);
  while fixing a worse problem, the repair accepts a route that only crosses a boundary if nothing
  clears everything. Crossing a boundary is never an error on its own.
- The side of a shape its notes sit on (above it, reading right; left of it, reading down) is
  reserved: no connector leaves or arrives there.
- A **reciprocal pair** — two relationships between the same two elements, one each way — is spaced
  further apart than an ordinary set of parallel connectors, so the two directions read as clearly
  separate lines rather than a small parallel nudge that could pass for one route with a kink.

**Quality gate** (`src/agent/quality.ts`). Connectors are checked exactly as the canvas draws them:
its trunks for fan-outs, its lanes for parallel pairs, and its label groups (`src/agent/route.ts`).

| Class | Checks | On create | On update |
| --- | --- | --- | --- |
| Error | shapes overlapping; a member outside its boundary; clipped text; a connector through an unrelated shape; a caption over a shape; two captions overlapping; a line through another connector's caption; two connectors drawn on top of each other for more than 30 px (outside a shared trunk); invalid geometry | Repaired, then `LAYOUT_FAILED` if still present (see below). With `layout.allowDegraded: true` the diagram is kept, and the receipt says `degraded: true` and lists the problems. | Only what the edit touched is judged. An error is `LAYOUT_CONSTRAINED`, and nothing changes. |
| Warning | a lone connector between facing sides that still steps sideways | Reported, and counted toward which candidate the repair keeps | Reported, and counted the same way |

Captions are judged where the canvas draws them: a connector's own label as its chip, and a
relationship caption as the canvas's `captionAnchor` places it — under a horizontal line, or on the
shared point of a trunk.

The repair is bounded:

- **Order.** Connectors are re-anchored — the other connector first when two meet — cheapest drawn
  route first, trying each pair of sides before variations of one, with at most 24 fully drawn
  candidates each. Then roomier spacing is tried; then the other reading direction, unless the
  caller chose one; then all of that again with balanced placement.
- **Best kept.** Candidates are compared errors first — a candidate with fewer errors always wins,
  however many stray warnings the other avoided — and only once errors are tied does the warning
  count decide it; the best one is what is used, never simply the last one tried. With no clean
  candidate, the request is refused rather than drawn, unless `allowDegraded`.
- **Time.** Repairs stop at a 6 s soft budget, and a worker still busy at 20 s is terminated. Either
  way the request is refused with nothing changed.

**`layout.viewport: [width, height]`** (px) names the frame the diagram is meant to be shown in.
When given, every candidate in the ladder above is also measured against it: the diagram's complete
rendered extent (every shape, plus every connector's route and caption exactly as drawn) is scaled to
fit the frame, and the smallest font size actually used by the diagram's own content is scaled with
it. A candidate that would leave text unreadably small at that size is ranked below one that wouldn't
— right after valid geometry and before route-length or spacing niceties — so, for instance, a caller
who left `direction` unset gets the orientation that actually fits the frame, not just the one that
happened to have no overlaps. Nothing is ever shrunk, clipped, or hidden to pass this check: with no
candidate reading well at the given size, the request is refused (`LAYOUT_FAILED`) with the scale and
effective font size in its `details`, the same way an unreadable layout already is — or kept anyway
with `layout.allowDegraded: true`, whose receipt then carries `fit: { scale, effectiveFontPx,
readable: false }` alongside the usual `degraded: true`. Omitted (the default), nothing about layout
selection changes.

**Legibility** (`src/agent/legibility.ts`). Readable isn't the same as clear: a diagram can pass
every check above and still send connectors across the whole canvas. So each arrangement is also
measured, on the connectors as drawn:

| Measure | What it counts |
| --- | --- |
| `crossings` | Places where two connectors cross (members of one trunk never count against each other) |
| `bundled` | Connectors drawn as branches of a shared trunk — parallel lines folded into one; a credit, not a cost |
| `detours` | Connectors drawn more than 1.5× the distance between their shapes' middles, plus 200 px |
| `throughBoundaries` | Connectors that pass through a boundary neither of their ends is in |
| `farNotes` | Notes more than 160 px from what they are about — where a read stops associating them |
| `fill` | Shapes' area over the diagram's bounding area; low means mostly empty space |

Between candidates the quality gate rates the same, legibility decides (with each warning counted as
one crossing). When the caller left `layout.direction` out and a clean candidate came early, the other
direction is laid out too; it replaces the default only when it costs at most 80% as much and saves at
least 25 points, so a diagram doesn't flip over a few pixels of connector. The create receipt carries
`legibility: {crossings, detours?, throughBoundaries?, farNotes?, fill}`, with the connector and note
ids listed (up to 10 each); an update receipt carries the same for the whole edited view.

**Advice** (`src/agent/advice.ts`). Some mess comes from the request itself, and the layout can't
undo it. The create receipt's `advisories` start with what to change, naming ids and, where there is
one, the `update_diagram` ops that do it:

- a boundary gathering only external systems or people, each called from a different shape, whose
  connectors detour or cut through something: ungroup its members (the ops to do so are given);
- a boundary of more than 8 elements, or a view of more than 15: draw a nested boundary one C4 level
  down, in an element's `inside` view;
- a note with no `about`, placed after the diagram: give it one;
- six or more crossings, two or more detours, or three connectors through boundaries: name the main
  path as `layout.primaryFlow` and list elements in reading order (or, with a main path already
  named, try `direction: "down"`).

`get_capabilities` with `topics: ["readability"]` gives the agent the whole checklist, each rule with
its reason, and the sidecar's instructions ask the agent to read it before its first create and to act
on the receipt's advisories in the same turn.

Every receipt carries a `quality` object: `scope` (`"whole-diagram"` for `create_diagram`, `"touched"`
for `update_diagram` — a partial check is never reported as if the rest of the diagram were vouched
for), `errors`/`warnings` counts, `errorsTruncated`/`warningsTruncated` when the listed `problems`/
`warningProblems` (capped at 10, each with its `kind` and affected `ids`) don't cover all of them.

**Updates never move existing elements, except by `arrange`.** New elements are placed as a block
beside the existing element they connect to most, on its connector line, upstream when they feed it.
Before refusing, the next-best hosts and the other side are tried; only the new part ever moves. A
boundary grows to hold new members. When nothing fits, `LAYOUT_CONSTRAINED` carries `suggestedOp` —
the narrowest `arrange` that would make room (the innermost boundary holding everything involved, or
the whole view) — for the agent to add to the same request.

**`arrange`** (`src/agent/arrange.ts`) is "clean up the layout": the same arrangement a new diagram
gets, applied in place. `{op:"arrange", scope?, direction?, spacing?, connectors?, move?, primaryFlow?}`:

- `scope` is the whole view by default, or `{group}` (with its contents), or `{nodes: [...]}`.
  Nothing outside it moves; a boundary it sits in only grows. A partial scope keeps its top-left
  corner, or is set beside where it was when that would collide; if nothing near is free it is
  refused with the whole-view arrange as `suggestedOp`.
- `direction` defaults to the way the view already reads. A whole-view arrange that leaves it out is
  also laid out the other way, and turned only when that reads clearly better — the same rule
  `create_diagram` applies (below); a scoped arrange always keeps the view's direction.
- `connectors`: `tidy` (default) re-anchors connectors touching the scope and drops hand routing on
  them; `keep` leaves hand routing; `orthogonal` also makes them right-angled. Connectors that don't
  touch the scope are untouched either way.
- `move: false` re-anchors connectors touching the scope without moving, resizing or re-peer-sizing
  any shape — a cheaper "just clean up the arrows" pass. An untouched neighbour sharing a side with a
  re-anchored connector keeps its own anchor exactly as it was; the re-anchored ones are placed clear
  of it, never on the slot it already occupies. Default `true` (the full placement pass).
- Ids, labels, C4 fields, attachments, notes' text and flows never change. A note inside a boundary
  stays with the shape it sits right beside (within 48 px), or else heads the boundary; a free note
  goes back beside the shape it sat closest to.
- Shapes keep their size unless their text needs more room, or `normalizePeerSizes` was asked for.

A "pinned" shape or a "preserve manual routes" request need no dedicated field: leaving a node out of
`scope.nodes` (or its group out of the scope) keeps it fixed, and `connectors: "keep"` preserves a
connector's hand routing. Nothing geometric beyond a connector's `routing` style and its two anchors
is ever persisted, so there is nothing for a reload, resize or move to silently discard — the drawn
path is always recomputed from the current shapes through the same `routeBetween` function the canvas
and the exporter call, never a second implementation that could drift from what the person sees.

The layout gallery — 21 cases in `tests/fixtures/agent/gallery.ts` — is asserted in
`tests/agent/gallery.test.ts`:

- no errors in any view;
- pixel-stable output;
- nothing pre-existing moved on update;
- at most one avoidable jog in the dense case, two in the card-provisioning case (its returns into the
  system) and none anywhere else;
- a system-context case (peer-uniform actors and external systems, no connector bent more than twice)
  checked on its own, as the regression it was built for;
- a container view with a nested domain, grouped external providers, a reviewer loop and three notes
  — reported as passing every check while reading badly — held to its legibility: each provider level
  with its caller, every note beside its subject, at most three crossings.

`npx tsx e2e/agent-gallery.ts --base <dev server> --out <dir>` renders every case in the real editor,
in light and dark, at 1440×900 and 1920×1080, for a person to look at. Rendered there, with the
canvas's own text measurement, every case comes out with no errors, and all but the dense and
card-provisioning cases with no warnings.

## Notes and flows

**Notes** relate to the diagram only in the ways the document model can hold:

| Request | What it becomes |
| --- | --- |
| `notes: [{id, text, kind?, about: <element>}]` | A native attachment on the element (the chip), under the note's id: it moves, exports and is removed with its host, and a read finds it on the element. An element already holding its 12 attachments takes the note beside it instead (the row below), with an advisory in the receipt — never a refusal. |
| `about: <element>, attach: false` | A free note laid out with the element, as one box: just before it across the flow (above, reading right; to its left, reading down), inside the element's boundary, with that side of the element kept free of connectors — for a callout meant to be read at a glance. Placement only: nothing records the link. Reads report a derived `nearest` element, labelled as placement. |
| `about: <relationship>` | Always an attachment on the connector: a line has no "beside". |
| `about: <group>` | A member of the boundary, placed at its head, under its title; the boundary grows to hold it. |
| no `about` | A free note in a column after the diagram (a row below it, reading down), and an advisory asking for an `about`. |

Text may be multiline; `kind` is `note`, `question`, `warning` or `decision`. The instructions ask
agents to add only notes that explain something, and to mark an inference from code as an assumption.
Edits are by id: `{op:"update", id, set:{text?, kind?, about?}}` edits or moves a free note (beside
another element, or into a group) or an attachment (to another element or relationship), and
`{op:"remove", ids:[id]}` removes either. Turning a free note into an attachment, or back, is a remove
and an add. A focused read includes the attachments of the focused elements in full.

**Flows** are named, ordered walks over relationships that already exist — adding one never adds
shapes. They show in the Flows panel, play in presentation mode and export as Mermaid and PlantUML
sequence diagrams.

- One call can create a diagram with its flows (`layout.primaryFlow` lays one out as the straight main
  path). A flow is only built from an order the person or the code gives; the instructions say never
  to infer one from the layout or the graph, and to ask when it is unclear.
- `{op:"update", id, set:{title}}` renames a flow and leaves its steps alone. With `set.steps`, a step
  whose relationship is still there keeps its id, its caption (unless `caption: null`), its extra
  highlights and its camera; frame steps come back from a read as `{frame: <stepId>}` and are kept by
  sending them back.
- A second flow with a title already in the view is refused with `DUPLICATE_FLOW`, naming the one to
  update. Separate paths (normal processing, a retry) are separate flows. A relationship is a step at
  most once per flow.
- There is **no stored default or "main" flow**: naming a flow "Main flow" gives it no special
  behaviour. Presenting picks the selected flow, or the only one.
- A flow may name another as `variantOf` — "Payment — failure path" naming "Payment"'s id — for a
  named alternative telling of the same scenario (a discussion of what happens if a step fails, built
  from existing elements and relationships rather than a simulation). Strictly hub-and-spoke: the
  flow named by `variantOf` must not itself carry one, which rules out chains and cycles without
  needing to walk one; setting `variantOf` to a flow that is already a variant is refused
  (`INVALID_REFERENCE`). Deleting the base flow clears the link on its variant rather than leaving it
  dangling. In the Flows panel and presentation's flow picker, a variant is listed right under its
  base; switching between the two mid-presentation (`Shift+F`, or the picker) lands on the step
  sharing a connector with the one being left, matched by the connector itself and never by step
  index, falling back to the first step only when no shared connector exists in the target.

## Live progress and preview

A request that takes a moment shows itself; one that doesn't, doesn't. Nothing is slowed down to be
seen.

- **Stages.** The worker reports the stage it is actually in — *Preparing diagram*, *Arranging
  components*, *Routing connections*, *Trying a roomier layout*, *Finishing layout* — never a made-up
  percentage. At the few points where one exists it also reports a **whole candidate**: every shape
  placed, every connector anchored. Never a half-built graph. Candidates are sent at most every
  250 ms, and at most one is kept per request.
- **Quiet when quick.** Nothing appears for a request that finishes within 300 ms.
- **Status line.** Past 300 ms a line appears above the status bar: "AI agent Drawing *title* —
  Routing connections…", with **Cancel** while cancelling still changes nothing, and **Show** for a
  new diagram or one that isn't open.
- **A change to the open diagram** is drawn over it as a provisional layer
  (`src/canvas/AgentPreviewLayer.tsx`): only what is added or changed, with the canvas's own shape and
  routing code, at a ghost's opacity inside a dashed outline under an "Agent's proposed change" tag.
  A boundary that grows is outlined at its new size, and anything removed is struck through where it
  stands. The person keeps panning, zooming and editing underneath. An edit of theirs meanwhile turns
  the agent's commit into `REVISION_CONFLICT`, and the layer goes.
- **A new diagram** (or one that isn't open) is shown in the generation view: a sheet marked "Not saved
  yet", drawn by the same renderer an export uses. It opens by itself only where it replaces nothing —
  Home, or an untouched Quick Draft — or when the agent passed `open: true`; otherwise **Show** opens
  it. It is framed once; after that the camera is the person's (drag to pan, wheel to zoom), and a
  new arrangement of another size keeps its middle in place. **Follow** frames every new one; **Fit**
  frames once; **Hide** closes the sheet and leaves the request running.
- **Cancel.** Before the commit gate, Cancel means nothing changes, and the agent gets `CANCELLED`
  (not retryable; the instructions say to ask before sending it again). Once the change is being
  applied the line says so and Cancel is gone: Undo is the way back. A client that disconnects is not
  a cancel — the request finishes and its answer waits in the ledger for a retry.
- **Transient, applied, persisted.** A preview is never part of the document, its history or
  autosave, and is gone when the request ends in any way, including a reload. *Applied* means the
  change is in the editor (one undo step); *persisted* means it is on disk, and the receipt's `state`
  says which.
- **For the agent.** When the client sends a `progressToken`, each change of stage goes back as an MCP
  progress notification with that phrase, and nothing else — never geometry or document text. The
  bridge frame is `{"type":"progress","id","message"}`, and an older connector just ignores it.

## C4 support

C4 is native, not a layer on top:

- **Levels** are the levels of Draft Canvas's rooms (`document.level`, `DraftNode.inside.level`). A
  drill-down is the room inside an element, at most 3 deep.
- **Text.** Schema v15 adds `description` (≤ 280 characters) and `technology` (≤ 60) to services,
  data stores, queues, actors and components. The canvas draws them under the name, and the inspector
  edits them (**Details**).
- **Boundaries** are `group` nodes with a kind: `system`, `domain`, `network`, `deployment`, `group` or
  `boundary`. Membership is the explicit `parentId`, never geometry.
- **Relationship technology** goes in the label (for example, "Makes API calls [JSON/HTTPS]") plus the
  native `semantic`.

**Role and scope are derived, never stored** (`src/depth/c4.ts`, shared by the editor and the bridge).
Each read returns `{role, scope, derived: true, basis}`, where `basis` names the native facts the
answer rests on.

| Element | context view | container view | component view | no level |
| --- | --- | --- | --- | --- |
| Actor: human, group | person | person | person | person |
| Actor: system, third party | software-system | software-system | software-system | unspecified |
| Actor: device | unspecified | unspecified | unspecified | unspecified |
| Service: external system | software-system | software-system | software-system | unspecified |
| Service: any other kind | software-system | container | unspecified — a service in a component view may be a supporting container or a component drawn as a service | unspecified |
| Data store, queue | unspecified | container | container | unspecified |
| Component (ports included) | unspecified | unspecified | component | unspecified |
| Boundary, note, text, code, junction | not a C4 element | | | |

Scope is `external` for an external system and for system or third-party actors. It is `internal` for
an element in a `system` boundary, or inside a drill-down (the room's owner is the thing the view is
about). Everything else is `unspecified`. A context view has no native "focal system" field, and
none is invented.

A mixed-level view produces **advisories**, never refusals: for example, a component in a context
view, or a data store at context level.

## Feature coverage

| Native feature | Create | Update | Read |
| --- | --- | --- | --- |
| Services, data stores, queues, actors, components, ports, junctions (29 type words, mapped to native type + kind) | ✓ | ✓ add, update (label, type, description, technology, colour, group), remove | ✓ |
| Relationships: label, semantic, behaviour, direction, async, condition | ✓ semantics from the capability matrix unless an offered one is named | ✓ | ✓ |
| Boundaries (six kinds, nested) | ✓ | ✓ add, rename, move members in, remove (`cascade`) | ✓ |
| C4 levels, description, technology, drill-down views | ✓ | ✓ `setLevel`, `view` targets a nested view | ✓ with derived role and scope |
| Flows (ordered steps over relationships, captions, colour, frame steps, named variants) | ✓ | ✓ add, rename, recolour, revise steps (step ids kept), link/unlink as a variant, remove | ✓ with frame steps |
| Notes (note, question, warning, decision): beside an element, inside a boundary, or attached | ✓ | ✓ add, edit text and kind, move, remove | ✓ with a derived `nearest` |
| Attachments: note and code chips on elements and relationships | ✓ | ✓ add, edit, move to another host, remove — by id | ✓ with `include: ["attachments"]`, or in full in a focused read |
| Actions (the canvas's to-do list, optionally about an element) | ✓ | ✓ | ✓ |
| Architecture Starters, with overrides and extra elements | ✓ `starter: {id, prefix?, overrides?}` | — (a starter is only a starting point) | ✓ as ordinary elements |
| Next-step suggestions | — | — | ✓ `include: ["suggestions"]`, never applied |
| Presentation, sequence diagrams, exports (PNG, SVG, Mermaid, PlantUML, draw.io, `.draftcanvas`) | not tools: the diagram is native, so the person presents and exports it from the app | | |
| `arrange` (re-lay-out existing content in place) | — | ✓ the view, a boundary or some elements | — |

## Limits

These are per request (`AGENT_LIMITS` in `src/agent/input.ts`). A breach answers `LIMIT_EXCEEDED`
with a JSON pointer to it.

| | |
| --- | --- |
| elements / relationships / groups | 300 / 600 / 60 |
| flows / steps per flow | 20 / 60 |
| notes / actions / ops | 60 / 50 / 100 |
| attachments per element | 4 |
| label / relationship label / group label | 120 / 80 / 80 characters |
| description / technology | 280 / 60 characters |
| note / code | 1,000 / 4,000 characters |
| drill-down depth | 3 |
| bridge frame | 4 MiB; at most 4 calls in flight per connection |

Text is never truncated to fit. A shape grows to 280 × 320 px; a label that still doesn't fit its
name in two 14 px lines is `LIMIT_EXCEEDED` with a hint to shorten it or use a note.

## Errors

Codes are stable. Each error carries `message`, and where useful `hint`, `retryable`, a JSON pointer
`path`, and up to 20 diagnostics. No error ever contains a stack trace or document content.

| Area | Codes |
| --- | --- |
| Input | `INVALID_INPUT`, `UNSUPPORTED_TYPE` (with the closest type words), `INVALID_REFERENCE`, `DUPLICATE_ID`, `CONTAINMENT_CYCLE`, `LIMIT_EXCEEDED`, `UNSUPPORTED`, `UNKNOWN_TOOL` |
| State | `REVISION_CONFLICT` (with `currentRevision`), `CURSOR_STALE`, `DOCUMENT_BUSY`, `BUSY`, `READ_ONLY`, `NOT_FOUND`, `AMBIGUOUS_DIAGRAM`, `DUPLICATE_TITLE` (with the existing diagrams), `DUPLICATE_FLOW`; `update_diagram` no longer returns `NOT_ACTIVE` (contract 1 only) — `read_selection` does, for a diagram that isn't the one open right now |
| Layout | `LAYOUT_FAILED`, `LAYOUT_CONSTRAINED` (with `suggestedOp`) |
| Retries | `REQUEST_ID_MISMATCH`, `OUTCOME_UNKNOWN` |
| Scope | `NOT_ENABLED`, `OUT_OF_SCOPE` (a folder an agent may not use, *or* an `update_diagram`/`submit_proposal` op reaching outside a captured `scope`, naming the ids), `SCOPE_TARGET_MISSING` (a captured scope id no longer in the view), `UNAUTHORIZED` |
| Proposals | `PROPOSAL_CLOSED` (`revises` named one that's already resolved, naming its actual status — including one resolved while the revision was being prepared), `PROPOSAL_CHANGED` (another revision of it landed first; read it again) — resolving one (accept/reject/dismiss) is a native UI action with its own outcomes, never a tool error an agent sees |
| Connection | `APP_UNAVAILABLE` (Draft Canvas isn't running), `APP_STARTING`, `APP_UNRESPONSIVE`, `CONNECTION_LOST`, `VERSION_MISMATCH`, `TIMEOUT`, `CANCELLED` |
| Other | `PERSISTENCE_FAILED`, `INTERNAL` |

## Security

The threat model is another local program, or a remote page, trying to drive the bridge. Neither
should be able to.

- **Off by default.** **Settings → AI agents** turns access on, and each project folder separately. A
  diagram outside an allowed folder can't be listed, read or changed, and scope is checked again on
  every call and every replay.
- **Local only.** The bridge is a Unix socket (mode 0600, in a 0700 folder) or a named pipe that
  rejects remote clients. There is no TCP port, and nothing is ever listening on the network. On
  macOS the peer's user id must match.
- **Token.** Turning access on writes `agent.json` (mode 0600) with the endpoint and a random token.
  - The sidecar presents the token in its hello, and it is compared in constant time.
  - The token never reaches the web page, and is never logged. The sidecar's stderr carries neither
    the token nor document content, which a test checks.
  - **Disconnect agents** replaces the token and ends every open connection. Turning access off
    removes the file and closes the listener.
- **Untrusted text.** Everything an agent sends is validated like an imported file, and the composed
  file must survive save-and-reopen with zero repairs before it is written. The sidecar's
  instructions tell the agent that text read from a diagram is data, never instructions.
- **Privacy.** Draft Canvas sends nothing anywhere. The agent's own model provider sees whatever the
  agent reads or writes; that is between the person and their agent. See [Privacy](privacy.md).

## Running while the window is hidden

Closing the window to the menu bar or tray normally lets the system throttle or suspend the page,
and the page is where diagrams are composed. How that is handled depends on the platform.

- **macOS 14 and later.** With agent access on, the window's web view is created with background
  throttling off. That is fixed when the window is created, so turning access on in a running app
  shows **Restart Draft Canvas so agents can reach it while its window is hidden**, and applies from
  the next launch.
  - Verified on macOS 27 with the packaged release app and its bundled connector. After 6 min 42 s
    with no window shown, it served list (1 ms), a 30-element create (385 ms), read (157 ms), and an
    update that activated the file and saved it (352 ms). An earlier run in the dev build measured
    30–53 ms after 6 min 40 s.
  - Also observed: with access turned on after launch, so throttling was left at WebKit's default, a
    hidden window still answered a create after 6 min 40 s (236 ms). WebKit doesn't promise that, so
    Settings keeps asking for the restart.
- **macOS 12–13 and Windows.** The platform offers no supported switch (Tauri's
  `backgroundThrottling` is macOS 14+ only). Settings says to keep the window open while an agent
  works.
  - A request that finds the page suspended times out cleanly: `APP_UNRESPONSIVE` before anything
    changed, or `OUTCOME_UNKNOWN` if the page stalled after the commit gate.
  - Not verified on those systems. No macOS 12/13 or Windows machine was available.

## Document compatibility and releases

The MCP bridge is desktop-only. The document format isn't: schema v15 (`description`, `technology`)
lives in the shared model, so a diagram an agent made opens, edits and saves the same way in the web
app, in VS Code and on the desktop. `e2e/round-trip.spec.ts` and `tests/host-document.test.tsx` cover
this.

An older Draft Canvas refuses a v15 file with an actionable message rather than dropping the fields.
This was checked against the released v14 reader:

> This file was made with a newer version of Draft Canvas (document format v15, this app reads up to
> v14).

**Release constraint.** The VS Code extension frames the *deployed* web editor, so v15 files open in
VS Code only once the web editor carrying v15 is deployed. The desktop app and the web editor must
therefore ship in the same release, which the single `vX.Y.Z` tag already does. Pages deploys only
released editor code.

## Performance

Measured on an Apple silicon Mac (macOS 27), in Chromium (Playwright) against the dev server, with
the editor's own canvas text measurement, so WebKit timings in the app will differ somewhat. Each
request was a tree of services, data stores and queues. Every label mixed Latin, accented and CJK
text, and a third of the elements carried a technology and a description. Times are wall-clock from
the page's side; the first includes the worker's start-up.

| Elements | Request | Arrange on the worker | Longest main-thread stall meanwhile | Gate result | File | Receipt | Full read |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 10 | 1.6 KB | 86 ms | 12 ms | clean | 6.8 KB | 182 B | 2.8 KB |
| 50 | 7.6 KB | 192 ms | 0 ms | degraded (1 caption problem) | 33 KB | 506 B | 13 KB |
| 200 | 31 KB | 1.5 s | 0 ms | degraded | 131 KB | 1.7 KB | 53 KB (one page) |

In tokens (estimated as characters / 4), a receipt is ≈ 50–430 and a full read of 50 elements is
≈ 3.3k. The same arrangement on the page's own thread took 5 ms, 166 ms and 1.45 s, with identical
geometry. A round trip through sidecar, broker and page added 30–53 ms in the desktop dev build.

"Degraded" means the quality gate found problems that the bounded repair couldn't fix. Without
`layout.allowDegraded: true` such a request is refused (`LAYOUT_FAILED`) rather than drawn.

Large one-shot requests (about 50 or more elements) often come back degraded, or are refused. Build
a big diagram in steps, or split it into drill-down views.

**Contract 2, measured in the packaged debug app** (macOS 27, WebKit, isolated app identifier), with
the scripted client in `e2e/agent-conversations.ts` and with Claude Code as a real client:

| Task | Before | After |
| --- | --- | --- |
| Scripted: create, add a DLQ and a note, add a flow, rename, clean up | 8 calls; 1 `NOT_ACTIVE` and a read before the first follow-up could land; cleanup impossible | 6 calls (1 create, 4 updates, 1 read to check); no correction rounds |
| Real client, the same four turns in natural language | 10 Draft Canvas calls, 94 s, 2 diagrams (the cleanup turn: 8 calls, 52 s, ids destroyed, a second diagram created) | 5 calls, 59 s, 1 diagram (the cleanup turn: 1 `arrange` call, 9 s) |
| Receipt size | 136–417 B | 205–363 B |
| Tool list + instructions | 18,935 + 672 B | 23,225 + 1,548 B |

Times are wall-clock per turn as the client saw them, model time included. The client's own
per-session cost report went from $0.65 to $0.45 for the four turns; that is what the client
printed, not a billing figure. A 34-element platform with four boundaries is created in 172 ms and
re-arranged in place in 117 ms, too quick for any preview to appear.

## Not supported, and why

- **Pinned shapes.** There is no lock flag in the document. Ordinary edits never move an existing
  shape, and `arrange` moves only its stated scope.
- **Some shapes of graph still don't lay out well.** One hub (an event bus) shared by four or more
  boundaries, or six or more labelled routes out of one gateway, is refused as unreadable or comes out
  tangled. Split it into views, or build it in steps.
- **A stored "main" flow, or a note linked to something without being attached.** Neither exists in
  the document model, so neither is claimed.
- **Exports as tools.** The diagram is native, so the person presents and exports it from the app.
  Returning image bytes to an agent adds nothing it can't get from `read_diagram`.
- **A separate relationship `technology` field.** It would need changes to both connector renderers
  (see `AGENTS.md`); the label carries it for now.
- **Linux.** Not a desktop target yet, so not a bridge target either.
- **Launching the app on connect.** If Draft Canvas isn't running, the sidecar answers
  `APP_UNAVAILABLE` and asks the person to open it.
- **Fetching or reading a PR, a repository, or any of an agent's own context.** `submit_proposal`'s
  `sourceRef` is a label the person can look at, never something Draft Canvas resolves — the agent
  keeps its own repository access, and the interpretation of what a diff means architecturally, to
  itself. There is no embedded model, no repository scanner and no GitHub authentication here.
- **Per-hunk merge review, or accepting part of a proposal.** A proposal is reviewed and applied (or
  not) as a whole; a smaller change means the agent revises the proposal before it's accepted.
- **Automatic code modification.** Draft Canvas validates, arranges, renders and persists a diagram
  change a person accepted; it never edits the repository the diagram might describe.
