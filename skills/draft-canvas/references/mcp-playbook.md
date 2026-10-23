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

## Reading a receipt

A create or update answers with:

- `revision` — pass it as `expectedRevision` next time.
- `quality` — `errors` (a create is refused unless `allowDegraded`; an update with errors is refused) and `warnings` such as a connector that jogs
  sideways. A warning is worth a look, not always a change.
- `legibility` — `crossings`, plus connectors that detour or cut through a boundary they're not in:
  the top view's at the top level, and every inside view's under `views`, each with its `view` path.
  Advice about an inside view starts "Inside <path>:".
- `advisories` — sentences naming what in the request to change, often with the exact ops. At most
  ten on a create, five on an update; `advisoriesDropped` counts the rest.

Apply the advisories that make sense in **one** `update_diagram`, then render. Two rounds of polish
is plenty; past that, tell the person what you would still change.

## Look before you finish

`render_diagram` returns the PNG the person would export. Render the top view and every inside view.
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
{ "op": "update", "id": "r9", "set": { "route": { "from": "bottom", "to": "left" } } }
{ "op": "remove", "ids": ["legacy-api"], "cascade": true }
{ "op": "arrange" }
{ "op": "arrange", "scope": { "group": "platform" }, "spacing": "spacious" }
{ "op": "moveInside", "owner": "orders", "ids": ["pricing", "repo"] }
{ "op": "moveOutside", "ids": ["pricing"] }
{ "op": "setLevel", "level": "container" }
```

`null` in `set` clears a field. Ops run in order as one change — one undo step for the person.
A new element is placed beside what it connects to; existing ones never move unless you arrange
or `set.place` them. A flow's steps keep their captions and highlights when `set.steps` keeps their
relationship.

## When something is refused

| Code | Meaning | Do |
| --- | --- | --- |
| `INVALID_INPUT`, `INVALID_REFERENCE` | A field or an id is wrong; the message names the path | Fix that field and resend with a new `requestId` |
| `DUPLICATE_ID` | An id is taken (ids are file-wide) | Rename it |
| `UNSUPPORTED_TYPE` | Unknown element type | Use a listed type, or set `fallbackType` |
| `DUPLICATE_TITLE` | A diagram with that title exists | Update that one, or ask the person; `allowDuplicateTitle` only on their say-so |
| `LAYOUT_FAILED` | No readable layout | Fewer elements per view (move detail inside), or send `allowDegraded` and fix after |
| `LAYOUT_CONSTRAINED` | A new element didn't fit beside its neighbours | Add the `suggestedOp` (an arrange) to the same update |
| `REVISION_CONFLICT` | The person edited meanwhile | `read_diagram`, rebuild the change on the new revision; or `onConflict: "rebase"` when your change doesn't touch what they edited |
| `LIMIT_EXCEEDED` | Too much in one request | Split it into a create plus updates |
| `OUT_OF_SCOPE` | Folder not enabled, or an id outside the `scope` you passed | Folder: tell the person which one to tick in Settings → AI agents. Scope: pass only ids from `read_selection`, or leave `scope` out |
| `BUSY` | The app is applying another change | Retry the same request (same `requestId`) shortly |
| `DOCUMENT_BUSY` | The person has unsaved or recovered changes to that diagram, or the file changed on disk under them | Don't retry. Ask them to save or discard, then `read_diagram` and rebuild the change |
| `NOT_FOUND` | No such diagram or view | `list_diagrams` again |

Never answer a failed update by creating a new diagram.

## Proposals

When the person asks to *review* a change against the diagram ("what does this PR change
architecturally? don't apply it"), send the ops through `submit_proposal` with a `summary`, a
`rationale`, `assumptions` and `openQuestions`. Draft Canvas shows it for them to accept or reject;
don't wait for the decision. `ops: []` with a summary is a valid "no architectural impact" answer.

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

