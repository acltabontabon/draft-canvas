# Draft Canvas MCP playbook

The tools, in the order this skill uses them, with what to do with each answer. The tool
descriptions themselves are the contract; this is the working knowledge around them.

## The calls

| Step | Call | Keep |
| --- | --- | --- |
| Learn the rules once | `get_capabilities({topics: ["readability"]})` | — |
| Find an existing diagram | `list_diagrams({query: "<system name>"})` | `diagramId`, `revision` |
| Read it | `read_diagram({diagramId, view?: {inside: [...]}})` | ids, `revision` |
| Draw it | `create_diagram({requestId, title, …, open: true})` | `diagramId`, `revision` |
| Look at it | `render_diagram({diagramId, view?, format: "png", scale: 1})` | — |
| Change it | `update_diagram({requestId, diagramId, expectedRevision, view?, ops})` | new `revision` |
| Try a change first | `preview_diagram({diagramId, expectedRevision, view?, ops})` | `previewId` |
| Propose instead of apply | `submit_proposal({requestId, diagramId, expectedRevision, ops, summary, rationale})` | `proposalId` |

- `requestId`: a fresh UUID for every create, update and proposal. Reuse one only to retry the exact
  same request (the app then answers with the first result instead of applying it twice).
- `view: {inside: ["storefront", "orders"]}` addresses a view by the element ids from the top down.
- `open: true` on create shows the diagram (only when that loses nothing the person has open).

## Read only what the task needs

`read_diagram({diagramId, include: ["views"]})` includes the view outline. Use its paths to address
rooms; `focus: {nodes: [ids]}`, `{group: id}` or `{flow: id}` narrows a read within one view. A focused
read is not the entire diagram: do not remove elements because they are absent from that response.
Follow its cursor when paginated. Request `include: ["geometry"]` for positioning, not routine edits.
Use `read_attachment` with the same revision and returned `nextOffset` when an attachment is truncated.

Read-only questions need no mutation. Small edits need no repository scan. A PR review becomes a
proposal, even if its dry run succeeds. Keep all views in a multi-view edit on the latest returned
file revision; do not fire concurrent mutations against the same revision.

## Reading a receipt

A create or update answers with:

- `created` (create) — `notes` counts free-standing cards; `attachments`, when present, counts
  notes and code attached to shapes or connectors throughout the file. A zero `notes` count does
  not mean attached notes were lost; read with `include: ["fullText"]` to inspect them.
- `revision` — pass it as `expectedRevision` next time.
- `quality` — `errors` (a create is refused unless `layout.allowDegraded`; an update with errors is
  refused) and `warnings` such as a connector that jogs sideways. A warning is worth a look, not always a change.
- `legibility` — `crossings` (and `crossed`, the pairs of relationships that cross), plus connectors
  that detour or cut through a boundary they're not in, connectors no clear line could be drawn for
  (`unresolved`) and shape sides too crowded to give each end its own point (`crowded`):
  the top view's at the top level, and every inside view's under `views`, each with its `view` path.
  Advice about an inside view starts "Inside <path>:".
- `pinned` (create) — connector ends the layout kept pinned because an automatic end would draw them
  differently. Every other end is automatic: it faces its shape and follows it when the person moves
  shapes, so leave ends alone unless the person wants one fixed.
- `advisories` — sentences naming what in the request to change, often with the exact ops. At most
  ten on a create, five on an update; `advisoriesDropped` counts the rest.

Create and arrange already try bounded routing repairs, then polish avoidable crossings and detours
without moving shapes again or sacrificing readable neighbours and shared trunks. Manual routes
and explicitly requested create pins stay as authored. A clean receipt needs no extra arrange pass.

Apply the advisories that make sense in **one** `update_diagram` per affected view, carrying each
returned file revision into the next call, then render. Two rounds of polish
is plenty; past that, tell the person what you would still change.

## Look before you finish

`render_diagram` returns the PNG the person would export. For a new map, render the top view and
every inside view. For edits, render only affected views.
Judge it as a reader:

- Does the main path read in one direction, mostly straight?
- Do labels fit on one or two lines? Shorten the long ones (`update` → `set.label`).
- Is anything connected to nothing, or far from what it talks to?
- Is a note chip or caption sitting on top of another label?

Fixes, smallest first: a shorter label (`set.label`); `{op: "update", id, set: {group: null}}` to take
an external out of a boundary; `set.route` to bend one connector by hand; `{op: "arrange"}` to lay the
whole view out again (ids, notes and flows kept). The input order of a create can't be changed
afterwards, so get it right before the first `create_diagram`.

### Straighten an inside view

`layout.primaryFlow` names the top view's main path; a create lays each inside view out around its
first flow. When an inside view's main path still comes out bent, or an update bent it, try the fix as
a preview, look, and apply only if it is better:

```json
preview_diagram({ "diagramId": "…", "expectedRevision": "…", "view": { "inside": ["storefront"] },
                  "ops": [{ "op": "arrange", "primaryFlow": "checkout" }] })
render_diagram({ "diagramId": "…", "previewId": "<from the preview>", "view": { "inside": ["storefront"] } })
update_diagram({ "requestId": "<new uuid>", "diagramId": "…", "expectedRevision": "…", "previewId": "<same>",
                 "view": { "inside": ["storefront"] } })
```

Arranging around one flow can make other lines worse; the render is how you know. A preview expires
after ten minutes and is never saved.

## Update ops

```json
{ "op": "add", "nodes": [...], "relationships": [...], "groups": [...], "flows": [...], "notes": [...] }
{ "op": "update", "id": "orders", "set": { "label": "Orders API", "technology": "Node.js 22", "description": null } }
{ "op": "update", "id": "checkout", "set": { "steps": [ ... ] } }
{ "op": "update", "id": "r9", "set": { "route": { "from": "bottom", "to": { "side": "left", "offset": 0.25 } } } }
{ "op": "update", "id": "r9", "set": { "route": { "from": "auto" } } }
{ "op": "remove", "ids": ["legacy-api"], "cascade": true }
{ "op": "arrange" }
{ "op": "arrange", "scope": { "group": "platform" }, "spacing": "spacious" }
{ "op": "moveInside", "owner": "orders", "ids": ["pricing", "repo"] }
{ "op": "moveOutside", "ids": ["pricing"] }
{ "op": "setLevel", "level": "container" }
```

`null` in `set` clears a field. Ops run in order as one change — one undo step for the person.
A route end is a side (pinned at its middle), `{side, offset}` (pinned exactly, 0–1 along the side) or
`"auto"` (unpinned: it faces the other shape and follows it). A pin is kept even when the shapes later
face away; `set.route: null` makes both ends automatic and drops the bends. `read_diagram` with
`include: ["geometry"]` gives each relationship's `pins` (an end missing there is automatic) and a
`status` when its line couldn't be drawn clear.
A new element is placed beside what it connects to; existing ones never move unless you arrange
or `set.place` them. A flow's steps keep their captions and highlights when `set.steps` keeps their
relationship.

## When something is refused

Every refusal carries a `hint` saying what to do; this is the short version.

| Code | Meaning | Do |
| --- | --- | --- |
| `INVALID_INPUT`, `INVALID_REFERENCE` | A field or an id is wrong; the message names the path | Fix that field and resend with a new `requestId` |
| `DUPLICATE_ID` | An id is taken (ids are file-wide) | Rename it |
| `UNSUPPORTED_TYPE` | Unknown element type | Use a listed type, or set `fallbackType` |
| `DUPLICATE_TITLE` | A diagram with that title exists | Update that one, or ask the person; `allowDuplicateTitle` only on their say-so |
| `LAYOUT_FAILED` | No readable layout | Fewer elements per view (move detail inside), or send `layout: {allowDegraded: true}` and fix after |
| `LAYOUT_CONSTRAINED` | A new element didn't fit beside its neighbours | Add the `suggestedOp` (an arrange) to the same update |
| `REVISION_CONFLICT` | The person edited meanwhile | `read_diagram`, rebuild the change on the new revision; or `onConflict: "rebase"` when your change doesn't touch what they edited |
| `LIMIT_EXCEEDED` | Too much in one request | Split it into a create plus updates |
| `OUT_OF_SCOPE` | Folder not enabled, or an id outside the `scope` you passed | Folder: tell the person which one to tick in Settings → AI agents. Scope: pass only ids from `read_selection`, or leave `scope` out |
| `BUSY`, `TIMEOUT`, `APP_UNRESPONSIVE` | Nothing was changed | Retry the identical request with the same `requestId`, at most twice |
| `OUTCOME_UNKNOWN` | The app stopped answering mid-change | `read_diagram` and compare before sending anything again |
| `READ_ONLY` | The diagram is read-only (on disk, or opened read-only) | Don't retry. Tell the person; it changes only once they can edit it |
| `DOCUMENT_BUSY` | The open diagram changed while the request waited; or the person has unsaved or recovered changes the file on disk disagrees with; or `activate` couldn't open it | Changed while waiting: `read_diagram` and send the change again. Unsaved or recovered changes: ask the person to save or discard, then `read_diagram` and rebuild it. `activate`: leave it out to change the file without opening it |
| `NOT_FOUND` | No such diagram or view | `list_diagrams` again |
| `NOT_ACTIVE` | `read_selection` or a selection render, but that diagram isn't open | Ask the person to open it and select, or read the whole view with `read_diagram` |
| `SCOPE_TARGET_MISSING` | An id in `scope` is gone since the selection was captured | `read_selection` again |
| `CURSOR_STALE` | The diagram changed between pages of a paged read | Read again from the first page |
| `DUPLICATE_FLOW`, `CONTAINMENT_CYCLE` | Moving inside or out would clash with a flow's title, or put a shape inside itself | Rename the flow first, or pick another owner |
| `REQUEST_ID_MISMATCH` | That `requestId` was used for a different request | Use a fresh UUID for every new change; reuse one only to retry the identical request |
| `CANCELLED` | The person stopped the request | Ask before sending it again |
| `PROPOSAL_ONLY`, `RUN_LIMIT` | In a Nodi run: changes go through review, and only to the run's diagram | Send the same ops with `submit_proposal`; work only on that diagram |
| `UNSUPPORTED` | The file isn't a diagram Draft Canvas can read | Tell the person; don't overwrite it |

Never answer a failed update by creating a new diagram.

## Proposals

When the person asks to *review* a change against the diagram ("what does this PR change
architecturally? don't apply it"), send the ops through `submit_proposal` with a `summary`, a
`rationale`, `assumptions` and `openQuestions`. Draft Canvas shows it for them to accept or reject;
don't wait for the decision. `ops: []` with a summary is a valid "no architectural impact" answer.

## Sequences

A sequence is a native element beside the architecture: participants, messages in order, replies,
conditions, loops and parallel branches, laid out by the app. Send one when the order, the replies or
the conditions go beyond what the relationships say (a protocol, a saga, an error path) — and only
from an order the person or the code gives. Write it as a Mermaid `sequenceDiagram`; `links` makes a
participant stand for an element of the same view, so it takes that element's name, kind and
technology and follows it:

```json
{ "op": "add", "sequences": [ { "id": "place-order", "title": "Place an order",
  "mermaid": "sequenceDiagram\n  actor shopper as Shopper\n  participant api as Orders API\n  participant db as Orders\n  shopper->>+api: POST /orders\n  api->>+db: INSERT order\n  db-->>-api: order id\n  alt payment accepted\n    api-->>shopper: 201 Created\n  else declined\n    api-->>-shopper: 402 Payment Required\n  end",
  "links": { "api": "orders-api", "db": "orders-db" } } ] }
```

`read_diagram` returns each sequence the same way (`mermaid`, `links`). `set.mermaid` replaces what
it holds and keeps the links of participants still written under the same ids; `set.title` renames
it; `set.links` re-links. A receipt advisory names anything in the text that is not drawn
(`autonumber`, `rect`, lost messages). `get_capabilities` topic `sequences` has the rest.

## Styled labels

A label's `text` is Markdown, drawn as such on the canvas and in every export: `#` headings,
`**bold**`, `` `code` ``, `==highlight==`, `[words]{.rose}` in a diagram colour, lists, `- [ ]` tasks,
tables, `> [!NOTE]` / `[!TIP]` / `[!WARNING]` callouts and fenced code with a language (` ```ts `,
` ```diff `). A single newline is a line break. `style` sets its look on the canvas — `role`, `font`
(`sans`, `serif`, `mono`, `hand`), `background` (`card`, `marker`, `banner`, in its `color`), `align`,
`bold`, `italic` — and only a free label has one, so give it `attach: false`:

```json
{ "id": "orders-sla", "kind": "label", "about": "orders", "attach": false,
  "text": "### Orders SLA\n| Endpoint | p99 |\n| --- | ---: |\n| `POST /orders` | 120 ms |\n\n> [!WARNING]\n> Ledger is called synchronously.",
  "style": { "background": "card", "color": "blue" } }
```

Change one later with `{ "op": "update", "id": "orders-sla", "set": { "style": { "font": "mono" } } }`;
`false` or `"none"` turns a field off, and `"style": null` makes the label plain.

