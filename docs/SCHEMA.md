# The `.draftcanvas` format

A Draft Canvas document is plain JSON. It can be diffed, committed to a repository, and read by a
human. Exporting one and importing it later restores a fully editable diagram — that is the point
of it existing at all, and it is what protects you from ever losing work to a cleared browser.

Defined in [`src/document/types.ts`](../src/document/types.ts).

## Shape

```json
{
  "format": "draft-canvas",
  "version": 4,
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
      "kind": "event",
      "async": true,
      "condition": "approved",
      "details": { "language": "json", "code": "{ \"status\": \"CANCELLED\" }" },
      "sourceAnchor": { "side": "right", "offset": 0.5 },
      "targetAnchor": { "side": "left", "offset": 0.35 }
    }
  ],
  "flows": [
    {
      "id": "f_p3q4r5",
      "title": "Happy path",
      "steps": [
        { "id": "fs_1", "edgeId": "e_g7h8i9", "caption": "Publish the cancellation event" },
        {
          "id": "fs_2",
          "extraNodeIds": ["n_a1b2c3", "n_d4e5f6"],
          "caption": "Where the account service and its handler live",
          "viewport": { "x": -80, "y": -40, "zoom": 0.9 }
        }
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
| `type` | enum | `ellipse` · `text` · `note` · `code` · `group` · `service` · `database` · `queue` · `actor` |
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
| `queueKind` | enum? | `queue` · `topic` · `stream`. `queue` nodes only. The violet horizontal-cylinder ("pipe") silhouette never changes; each kind is captioned (`QUEUE`/`TOPIC`/`STREAM`, as a small muted subtext line under the name) since none of the three is a placeholder default the way `serviceKind`'s and `databaseKind`'s `generic` are. |

### Attachment

Supporting detail (a note, a code snippet, free text) collapsed into a host node rather than left
as an independent element. Reveals in a small popover from the host's attachment badge; detaching
one restores it as an ordinary node on the canvas.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Unique within the node. Stable across edits and reordering. |
| `type` | enum | `code` · `note` · `text`. |
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
| `semantic` | enum? | `http` · `grpc` · `event` · `command` · `query` · `reads` · `writes` · `publishes` · `consumes` · `calls` · `dependsOn` · `fansOut` · `deliversTo` · `ingests` · `replicates` · `cdc` · `syncs`. Optional convenience only — fills in a default `label` when picked on a labelless edge (skipped for a pairing the relationship model flags as unusual, see below), never assigned automatically, never changes `accent`. |
| `kind` | enum? | `sync` · `async` · `event` · `callback` · `conditional` · `retry` · `failure` · `fallback`. A connector's flow behaviour — line style and a small glyph, not a protocol taxonomy. Independent of `semantic` (a label convenience) and `async` (solid/dashed); the one exception is `kind: "async"` itself, which defaults `async` to `true` the same way a `semantic` fills in a default label — never forced, and either can still be changed afterward on its own. See [`docs/FLOWS.md`](FLOWS.md#flow-kind). |
| `async` | boolean? | `true` renders a dashed line for an asynchronous interaction. Absent/`false` is synchronous (solid) — a visual distinction only, no protocol taxonomy. |
| `response` | string? | The reply chip's own text, e.g. `"200 Customer"` — only meaningful alongside `hasResponse`. |
| `hasResponse` | boolean? | Whether this connector draws a second, quieter reply line back to its source, independent of whether `response` has text. Defaults on for a fresh Service↔Service connection (see [Relationship model](#relationship-model) below), off otherwise; always a manual, reversible choice afterward. |
| `condition` | string? | Free-text chip, e.g. `"approved"`, `"timeout"` — displayed, never evaluated. Distinct from `label`: the label describes the connection in general, the condition describes when a particular branch applies. |
| `sourceAnchor` `targetAnchor` | object? | `{ side, offset }` — which side of the node (`top` · `right` · `bottom` · `left`) the connector attaches to, and how far along it (`offset`, a 0–1 fraction of the side's length; `0.5` is the midpoint). Captures the side the user actually dragged the connection from or onto — see [Connector anchors](#connector-anchors) below. Absent on either end falls back to picking the nearest side live, the same way every connector worked before this field existed. |
| `semanticsOrigin` | `"inferred"` · `"explicit"` ? | Whether `semantic`/`kind` were derived automatically from what the connector links (`"inferred"`, freely re-derived on a later reconnect) or set by hand (`"explicit"`, never silently overwritten). Absent alongside a real `semantic`/`kind` value reads as legacy-explicit (a file saved before this field existed) — never as "up for grabs." |
| `attachments` | array? | Optional supporting detail (a note, or a code/JSON snippet) on the connection itself — the same [Attachment](#attachment) shape a node uses. Hidden by default, at most a small chip per attachment; reveals its own card on hover or selection. Created by dragging an existing Note/Code node onto the connector (mirrors dragging one onto another node), not through a toolbar control. A separate, newer field from `details` above, which stays as its own thing (read during flow playback only). Up to `maxAttachmentsPerEdge`, and the UI renders every one of them, each styled to match its own type (a note reads as a note, code as code). |

### Relationship model

`semantic`/`kind`/`hasResponse` above are optional conveniences a person can always override, but
Draft Canvas fills in a sensible default for most pairings up front, and gently flags an unusual
one instead of staying silent. `src/document/connectorSemantics.ts` derives all of this from
`sourceNodeCategory × targetNodeCategory` (a node's `type`, and for `service`/`database`/`queue` its
sub-kind — `serviceKind: 'external'`, `databaseKind: 'cache'`, `queueKind: 'topic'` each read as
their own category) — a Service→Database connection defaults to `writes`, a fresh Service↔Service
one defaults to a request/response pair with a subtle "requests" caption, a Topic→Queue connection
reads as fan-out, and so on. A pairing the model has no opinion about (most of them) keeps full,
unrestricted freedom — nothing here ever hard-blocks a connection.

A pairing can additionally carry a `status` (`unusual` today; a `questionable` tier is modeled for a
future one) with a short guidance message and, sometimes, a one-click quick fix — e.g. Queue→Topic
(a queue does not typically publish into a topic on its own) offers "Insert Worker," which replaces
that one connector with a new Worker service node and two correctly-labeled connectors
(Queue→Worker `consumes`, Worker→Topic `publishes`) as a single undo step. None of this is
persisted structurally — it is derived live from the two endpoint nodes' current types every time,
so re-pointing a connector to a different kind of node re-evaluates it fresh.

### Connector anchors

An anchor is the user's explicit choice of where a connector starts or lands, not routing
geometry — nothing here is recomputed and overwritten on load the way, say, a node's rendered
size is. Once a side is set, routing must never move it to another side on its own; only an
explicit reconnect (dragging that endpoint elsewhere) changes it. An edge missing an anchor on one
or both ends — every edge in a file written before v3, and any new edge whose endpoint was a body
hit rather than a specific handle — just falls back to the live nearest-side heuristic for that
end, exactly as it always has.

### Flow

A named, ordered walkthrough of existing connectors — an explanation layer over the architecture,
not a second copy of it. Multiple flows may reference the same connector at different positions;
switching flows never changes a node or edge. See [`src/document/flow.ts`](../src/document/flow.ts).

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Unique within the document. |
| `title` | string | e.g. `"Happy path"`, `"Payment timeout"`. |
| `steps` | array | Ordered — order is the array position, not a stored number. Each `{ id, edgeId?, extraEdgeIds?, extraNodeIds?, viewport?, caption? }`. `edgeId` is a step's primary connector; optional so a "frame" step can spotlight a group with no single connector driving it. `extraEdgeIds`/`extraNodeIds` are further connectors/nodes the step highlights beyond `edgeId`'s own two endpoints — every member gets the same active/shown/hidden treatment during playback, with no primary/secondary distinction once a step is current. `viewport` (`{ x, y, zoom }`), when present, is shown verbatim during that step instead of the usual fit-to-bounds. `caption` is optional and, when absent on a step with a primary edge, playback falls back to that connector's own `label`. A dangling reference (`edgeId`, or an entry in `extraEdgeIds`/`extraNodeIds`) is dropped from the step, not the whole file; a step left with nothing at all — no primary, no extras, no viewport — is the only one actually removed. |
| `accent` | enum? | As for nodes/edges. Applied to this flow's member connectors only while it's the active lens (selected or presenting) — never a permanent per-edge colour, since a connector can belong to several flows. Absent renders every member with its own normal styling, exactly as before this field existed (v4). |

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
| Extra nodes/edges per step | 40 each |
| Flow title | 100 characters |
| Condition | 120 characters |

## Reading a file: repair, don't reject

Imports are untrusted. A file is refused outright only when it is unrecognisable or comes from a
newer format version. Everything else is repaired, and the repairs are reported:

- Unknown node types become `note`, keeping their text rather than losing the content.
- Missing or duplicate ids are replaced.
- Connections pointing at absent nodes, or pointing a node at itself, are dropped.
- Grouping links that dangle, point at themselves, or form a cycle are detached.
- Non-finite and out-of-range numbers are clamped.
- Control characters are stripped from text; tabs and newlines are kept.
- A flow step's dangling reference — a primary connection that no longer exists, a duplicate
  primary within one flow, or an entry in `extraEdgeIds`/`extraNodeIds` pointing at something
  gone — is repaired away individually; the step itself is only dropped if nothing is left on it
  at all.

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

**Worked example — v2 → v3:** v2 had no `sourceAnchor`/`targetAnchor` at all — every connector's
attachment side was picked live, on every render, by the same nearest-side heuristic that still
serves as today's fallback. The migration runs that identical heuristic once per edge lacking an
anchor, using the endpoint nodes' geometry as written in the file, and persists the result — so a
migrated document's on-screen appearance is byte-identical to how it looked in v2, and the anchor
is computed exactly once rather than re-derived on every future load. An edge whose endpoint no
longer resolves to a node is left alone; `normalizeDocument` drops it afterward the same way it
always has.

**Worked example — v6 → v7:** v6 had two blank, semantics-free box node types, `card` and
`rounded` — near-duplicates of each other, differing only in corner radius. v7 removes both; there
is no generic "just a box" primitive anymore. The migration retypes any `card`/`rounded` node — and
any `card`/`rounded` attachment folded into a node or edge — to `note`, the closest surviving
primitive that holds free text with no other implications. Every other field (text, position, size,
accent) is left untouched, so a migrated document keeps showing the same content in the same place,
just under a different type. `normalizeDocument`'s fallback for an unrecognised type also changed
from `card` to `note` to match.
