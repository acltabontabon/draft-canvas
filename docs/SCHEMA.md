# The `.draftcanvas` format

A Draft Canvas document is plain JSON. It can be diffed, committed to a repository, and read by a
human. Exporting one and importing it later restores a fully editable diagram — that is the point
of it existing at all, and it is what protects you from ever losing work to a cleared browser.

Defined in [`src/document/types.ts`](../src/document/types.ts).

## Shape

```json
{
  "format": "draft-canvas",
  "version": 2,
  "metadata": {
    "id": "d_x8k2m4p9qr7t",
    "title": "Account cancellation",
    "createdAt": 1788000000000,
    "updatedAt": 1788000120000
  },
  "nodes": [
    {
      "id": "n_a1b2c3",
      "type": "service",
      "x": 250, "y": 160, "width": 176, "height": 68, "z": 0,
      "text": "Account Service",
      "accent": "teal"
    },
    {
      "id": "n_d4e5f6",
      "type": "code",
      "x": 250, "y": 480, "width": 430, "height": 190, "z": 0,
      "language": "java",
      "code": "@Transactional\npublic void cancel(Account account) {\n  account.cancel();\n}"
    }
  ],
  "edges": [
    {
      "id": "e_g7h8i9",
      "source": "n_a1b2c3",
      "target": "n_j0k1l2",
      "directed": true,
      "routing": "smoothstep",
      "label": "ACCOUNT_CANCELLED",
      "async": true,
      "condition": "approved",
      "details": { "language": "json", "code": "{ \"status\": \"CANCELLED\" }" }
    }
  ],
  "flows": [
    {
      "id": "f_p3q4r5",
      "title": "Happy path",
      "steps": [
        { "id": "fs_1", "edgeId": "e_g7h8i9", "caption": "Publish the cancellation event" }
      ]
    }
  ],
  "viewport": { "x": 0, "y": 0, "zoom": 1 },
  "settings": { "showSequence": true, "grid": "dots" }
}
```

## Fields

### Top level

| Field | Type | Notes |
| --- | --- | --- |
| `format` | `"draft-canvas"` | Required. A file without it is refused. |
| `version` | integer | Schema version. A file from a newer version is refused with an explanation rather than half-read. |
| `metadata` | object | Identity and timestamps. |
| `nodes` | array | Elements on the canvas. |
| `edges` | array | Connections between them. |
| `flows` | array | Named, ordered walkthroughs of existing connections — see [Flow](#flow) below. |
| `viewport` | object | `x`, `y`, `zoom` — where the canvas was left. |
| `settings` | object | `showSequence` (boolean — show a flow's step badges on its connectors when it's selected for overlay), `grid` (`dots` · `lines` · `none`). |

### Node

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Unique within the document. |
| `type` | enum | `card` · `rounded` · `ellipse` · `text` · `note` · `code` · `group` · `service` · `database` · `queue` · `actor` |
| `x` `y` | number | Absolute canvas coordinates — never relative to a parent. |
| `width` `height` | number | |
| `z` | number | Stacking order. Boundaries always render behind their contents regardless. |
| `parentId` | string? | Group membership. Coordinates stay absolute. |
| `text` | string? | The label. Always plain text — never markup. |
| `accent` | enum? | `neutral` · `teal` · `blue` · `violet` · `amber` · `rose` · `green`. A closed set, not a colour value. |
| `noteKind` | enum? | `note` · `question` · `warning` · `decision`. Notes only. |
| `language` | enum? | `plaintext` · `java` · `javascript` · `typescript` · `json` · `yaml` · `xml` · `sql` · `bash` · `http` · `log`. Code cards only. |
| `code` | string? | Code-card contents. Stored and rendered as text; never executed. |
| `attachments` | array? | Supporting detail folded into this node — see [Attachment](#attachment) below. Up to `maxAttachmentsPerNode`. |
| `boundaryPreset` | enum? | `boundary` · `system` · `domain` · `network` · `deployment` · `group`. `group` nodes only. A loose, technology-neutral label rendered as a small caption — never mutates the node's own `text`. |
| `serviceKind` | enum? | `generic` · `api` · `worker` · `external`. `service` nodes only. Renders as a small caption; the teal silhouette never changes. |
| `databaseKind` | enum? | `generic` · `sql` · `nosql` · `cache`. `database` nodes only. Renders as a small caption; the blue silhouette never changes. |
| `queueKind` | enum? | `queue` · `topic` · `stream`. `queue` nodes only. Renders as a small caption; the violet silhouette never changes. |

### Attachment

Supporting detail (a note, a code snippet, free text) collapsed into a host node rather than left
as an independent element. Reveals in a small popover from the host's attachment badge; detaching
one restores it as an ordinary node on the canvas.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Unique within the node. Stable across edits and reordering. |
| `type` | enum | `code` · `note` · `text` · `card` · `rounded`. |
| `text` `noteKind` `language` `code` `accent` | — | Same meaning as the equivalent `Node` fields. |
| `width` `height` | number? | Preserved from the source node so detaching restores its size, not a type default. |

### Edge

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Unique within the document. |
| `source` `target` | string | Node ids. An edge naming a node that does not exist is dropped on import. |
| `directed` | boolean | `false` draws a plain line with no arrowhead. |
| `routing` | enum | `smoothstep` · `bezier` · `straight`. |
| `label` | string? | |
| `accent` | enum? | As for nodes. |
| `details` | object? | `{ language, code }` — expandable detail shown on selection and during its playback step. |
| `semantic` | enum? | `http` · `event` · `command` · `query` · `reads` · `writes` · `publishes` · `consumes` · `calls` · `dependsOn`. Optional convenience only — fills in a default `label` when picked on a labelless edge, never assigned automatically, never changes `accent`. |
| `async` | boolean? | `true` renders a dashed line for an asynchronous interaction. Absent/`false` is synchronous (solid) — a visual distinction only, no protocol taxonomy. |
| `condition` | string? | Free-text chip, e.g. `"approved"`, `"timeout"` — displayed, never evaluated. Distinct from `label`: the label describes the connection in general, the condition describes when a particular branch applies. |

Connection anchors are **not** stored. They are recomputed from node positions, so connections
re-route themselves when things move and a file cannot carry stale geometry.

### Flow

A named, ordered walkthrough of existing connectors — an explanation layer over the architecture,
not a second copy of it. Multiple flows may reference the same connector at different positions;
switching flows never changes a node or edge. See [`src/document/flow.ts`](../src/document/flow.ts).

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Unique within the document. |
| `title` | string | e.g. `"Happy path"`, `"Payment timeout"`. |
| `steps` | array | Ordered. Each `{ id, edgeId, caption? }` — `edgeId` references an existing connection; order is the array position, not a stored number. `caption` is optional and, when absent, playback falls back to the connector's own `label`. A step whose connector no longer exists is dropped, not left dangling. |

## Limits

Applied to anything read from a file or from a possibly-corrupted local record. Defined in
[`src/document/limits.ts`](../src/document/limits.ts).

| Limit | Value |
| --- | --- |
| File size | 24 MB |
| Nodes | 5,000 |
| Edges | 10,000 |
| Title | 200 characters |
| Node text | 20,000 characters |
| Code | 200,000 characters |
| Connector label | 500 characters |
| Coordinates | ±1,000,000 |
| Node size | 24 – 20,000 |
| Zoom | 0.1 – 4 |
| Flows | 50 |
| Steps per flow | 200 |
| Flow title | 100 characters |
| Condition | 120 characters |

## Reading a file: repair, don't reject

Imports are untrusted. A file is refused outright only when it is unrecognisable or comes from a
newer format version. Everything else is repaired, and the repairs are reported:

- Unknown node types become `card`, keeping their text rather than losing the content.
- Missing or duplicate ids are replaced.
- Connections pointing at absent nodes are dropped.
- Grouping links that dangle, point at themselves, or form a cycle are detached.
- Non-finite and out-of-range numbers are clamped.
- Control characters are stripped from text; tabs and newlines are kept.
- A flow step referencing a connection that does not exist (or a duplicate step for the same
  connection within one flow) is dropped, keeping the rest of that flow in order.

A diagram with three broken connections opens with the other ninety-seven intact.

## Evolving the format

`version` is read in exactly one place: [`src/document/migrate.ts`](../src/document/migrate.ts).
Nothing in the UI branches on it.

To add a version:

1. Increment `CURRENT_VERSION` in `src/document/types.ts`.
2. Add `MIGRATIONS[n]` in `migrate.ts`, taking a version-`n` object and returning a version-`n+1`
   one.
3. Add a round-trip test for a fixture in the old format.

Older files then open through the migration chain. Newer files are refused with a message naming
both versions, rather than being silently mangled.

**Worked example — v1 → v2:** v1 had a single, document-wide numbered walkthrough
(`edge.sequence`). v2 replaces it with `flows`, so several independent, named walkthroughs can
share or diverge on the same connectors — something one number per edge could not represent. The
migration collects every edge with a `sequence`, sorts by that number, and synthesizes one flow
titled `"Walkthrough"` from them (skipped entirely if nothing was sequenced), then strips
`sequence` from the edges. An old file's existing walkthrough opens and plays back exactly as it
did before; multiple flows are new, additive capability from there.
