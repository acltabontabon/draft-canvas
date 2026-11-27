# Document schema and versioning

The migration and validation contract for `.draftcanvas` files. If this drifts from the code, the
code wins.

## The file

A document (`DraftDocument` in `src/document/types.ts`) is JSON with these root fields:

| Field | Contents |
| --- | --- |
| `format` | Always `"draft-canvas"` |
| `version` | Format version, currently **34** (`CURRENT_VERSION`) |
| `metadata` | `id`, `title`, `createdAt`, `updatedAt`, optional `projectId` |
| `nodes`, `edges`, `flows`, `viewport` | The top-level graph |
| `ink` | Optional handwritten strokes over the top-level graph (`DraftInk`). Absent when there are none |
| `settings` | Canvas settings: the grid and whether a flow's step badges show |
| `openPoints` | Unsettled questions attached to elements. Root only |
| `level` | Optional `ViewLevel` |
| `style` | Optional: how the diagram is drawn (see [Style](#style)). Root only |

A node may own a room (`DraftNode.inside`): its own `nodes`, `edges`, `flows`, `viewport`, and
optional `ink` and `level`. A document is a tree of graphs, nested at most 3 levels below the root.

A node of type `sequence` carries a `sequence` payload (`DraftSequence`): `participants`, optional
`groups` of neighbouring participants, and `items` in order: messages, notes and fragments, whose
operands hold items in turn. `numberMessages: false` hides message numbers. Nothing in the payload is
a coordinate: layout, work bars and the node's size are derived.

- Ids inside a sequence are local to the node.
- A participant has a shape's identity fields (`type`, kind, `technology`, `accent`) and an optional
  `ref`, the id of the shape in the same view it stands for.
- A message has `from`, `to`, a `kind` (`sync`, `async`, `reply`, `create`, `destroy`), a `label`,
  optional `replyTo`, `activate` / `deactivate` flags, and optionally an `attachments` array with the
  same note and code payloads as a canvas connector.
- A canvas connector can attach to a participant through `sourceAnchor.participantId` or
  `targetAnchor.participantId`; its anchor offset is then measured along the participant's lifeline.

A Junction (a node of type `ellipse`) may carry `link`, an opaque id of at most 128 characters.
Junctions with the same `link`, in any room of the file, are one continuation point drawn in
several places. It is kept on Junctions only, is never a node id, and is read on its own: a link no
other Junction shares is valid. Their labels are each node's own `text`.

IndexedDB's `bodies` store holds the same shape.

## Versions and migrations

`src/document/migrate.ts` is the only code that reads `version`. `MIGRATIONS[n]` upgrades a
version-`n` document to `n + 1`. `migrateToCurrent` runs the chain:

- A missing `version` is treated as 1. A present but unreadable one (a string, a fraction, `null`, zero or negative) is refused, so a current file never runs through the whole chain.
- A version newer than `CURRENT_VERSION` throws `UnsupportedVersionError`, naming both versions.
- A gap in the chain throws `Missing migration from document format v${v} to v${v + 1}.`

Rules for a new version:

- Bump `CURRENT_VERSION` and add exactly one entry, even a no-op.
- A migration that touches nodes, edges or flows must reach every room: write it for one graph and
  wrap it with `everyRoom` (built on `mapGraphs`).
- A new field that an older build's validation would strip still needs a version bump, so the older
  build refuses the file instead of silently writing back a stripped copy.

| Transition | Migration | Change |
| --- | --- | --- |
| v1 → v2 | `migrateSequenceToFlows` | `edge.sequence` becomes one named Flow |
| v2 → v3 | `migrateAnchors` | Connector anchor sides and offsets are persisted |
| v3 → v4 | `migrateFlowAccent` | No-op (per-flow accent) |
| v4 → v5 | `migrateBackground` | No-op (canvas background image, since retired) |
| v5 → v6 | `migrateResponse` | No-op (connector response) |
| v6 → v7 | `migrateCardAndRoundedToNote` | `card` and `rounded` nodes and attachments become `note` |
| v7 → v8 | `migrateHasResponse` | `hasResponse: true` on edges that already had `response` text |
| v8 → v9 | `migrateAddProjectId` | No-op (`metadata.projectId`) |
| v9 → v10 | `migrateAddRouteMode` | No-op (`routeMode`) |
| v10 → v11 | `migrateBffToApi` | `serviceKind: 'bff'` becomes `'api'` |
| v11 → v12 | `migrateAddInsides` | No-op (`DraftNode.inside`) |
| v12 → v13 | `migrateAddActions` | No-op (root `actions`, since removed) |
| v13 → v14 | `migrateProjectsToWrites` | `semantic: 'projects'` becomes `'writes'` |
| v14 → v15 | `migrateAddC4Text` | No-op (`description`, `technology`) |
| v15 → v16 | `migrateAddOpenPoints` | No-op (root `openPoints`) |
| v16 → v17 | `migrateActionsToNotes` | Root `actions` become note attachments on their target, or lines in one `Actions` note |
| v17 → v18 | `migrateReadsWritesLabel` | A `writes` connector labelled "reads / writes" becomes `readsWrites` with the label cleared |
| v18 → v19 | identity | No-op (optional source evidence) |
| v19 → v20 | `migrateAddWaypoints` | No-op (connector `waypoints`) |
| v20 → v21 | `migrateTextToMarkdown` | Text node and Text attachment `text` (on shapes and connectors) is escaped so it reads the same as Markdown |
| v21 → v22 | identity | No-op (optional linked compensation fields on connectors) |
| v22 → v23 | identity | No-op (retired per-connector style overrides are discarded by normalization) |
| v23 → v24 | identity | No-op (optional `replicas` on Services and `kindOrigin` on Services, Data Stores and Queues) |
| v24 → v25 | identity | No-op (optional connector `cadence`) |
| v25 → v26 | identity | No-op (the `sequence` node type and its payload) |
| v26 → v27 | identity | Message attachments and larger sequence frames |
| v27 → v28 | identity | No-op (optional `ink` on the document and every room) |
| v28 → v29 | identity | No-op (optional `held` on shapes and `portal` on connectors) |
| v29 → v30 | `migrateCardKindsToGlyphs` | A Service of kind `worker`, `external`, `scheduler` or `gateway` grows to the height its glyph, name and details need (114, 128 with a technology, 143 with a description), placed so the glyph's middle is where the card's middle was: those kinds are drawn as a glyph with the name underneath. Also the first version with the `artifact` shape and `serviceKind` of `load-balancer` and `proxy` |
| v30 → v31 | `migrateComponentKindsToGlyphs` | A Component of kind `module`, `adapter` or `port` grows the same way, for the same reason: those kinds are drawn as a glyph with the name underneath |
| v31 → v32 | identity | No-op (optional root `style`: how the diagram is drawn). Background images are retired: `settings.background`, with any image inside it, is discarded by normalization |
| v32 → v33 | identity | No-op (optional `link` on Junctions: the group a Junction continues in). Junctions that only share a label are not linked by the migration |
| v33 → v34 | `migrateExternalToCard`, `migrateApiToGlyph`, `keepGlyphPins` | A Service of kind `external` gives back the height its glyph took (68 from a box with only a name, 40 from one with a technology or a description, never below 68), placed so the card's middle is where the glyph's middle was: the kind is drawn as a card with a dashed outline and its name inside, and a pin on its left or right keeps the height it was drawn at. A Service of kind `api` grows the way v30 grew a Worker, with its side pins kept at the height they were drawn: it is drawn as a glyph with the name underneath. A pin on the top or bottom of any shape drawn as a glyph is given the offset that keeps it where it was drawn, or at the glyph's corner: those anchors are spread along the glyph's reach, not the whole box |

Wrapped in `everyRoom`: the migrations from v1, v2, v6, v7, v10, v13, v17, v20, v29, v30 and v33. `migrateActionsToNotes` is
root-only but walks rooms itself to resolve anchors.

**Compensating actions** are ordinary connectors. One can name its originating interaction
(`compensationFor`), keep its line folded (`compensationVisible: false`), and carry a business name
(`compensationName`), protocol (`compensationProtocol`) and context (`compensationDescription`); its
`label` stays the counteraction operation. MCP `create_diagram`, `read_diagram` and `update_diagram`
expose these fields. Older unlinked `compensates` connectors stay visible, since migration never
guesses which operation they counteract; an invalid link is removed and the action stays editable.
An HTTP action's operation starts with a verb, linked or not: free text such as `refund` reads
`POST refund`, and the old placeholder `OK` is removed.

## Validation

`parseDocument()` in `src/document/validate.ts` is the only way a document enters the app: file
open and import, IndexedDB load, decrypted `.dcenc` import and clipboard paste
(`src/document/clipboardCodec.ts`). Policy: repair, don't reject.

Rejected outright:

- Input over `maxFileBytes` (24 MB).
- Invalid JSON, or a missing `"draft-canvas"` format marker.
- A newer `version`.

Repaired, after migration, and reported to the caller:

- Enums are checked against closed sets; invalid values fall back or are dropped.
- Text has control characters stripped and is length-clamped. A title, a connector label, a
  description and a technology are also trimmed (a technology on one line, a title never cut mid-emoji),
  and none left means the field is absent. The editor writes them the same way, so a save holds what
  the next open keeps.
- Numbers are coerced to finite values and clamped.
- Collections over their limit are truncated. `maxNodes` and `maxEdges` are one allowance across
  the file, spent outermost first.
- Dangling references are dropped: edges to missing nodes, missing `parentId` boundaries, flow
  steps to missing edges.
- Boundaries nested deeper than `maxGroupDepth` lose the link ("Removed … invalid grouping link(s)");
  the editor refuses to nest that deep, so only a hand-edited file reaches it.
- Rooms deeper than `maxInsideDepth` are dropped. A room with no shapes is dropped. Shape,
  connector and flow ids are unique across the whole file; a flow step's id is unique within its
  flow, and an attachment's within the shape or connector that carries it. A missing or repeated id
  gets a new one, and the report says how many.
- `ink` strokes are read per room: an unknown `tool` or unreadable points drop the stroke; size is
  clamped; a `pressure` list that doesn't match the points is dropped; ids are unique across the
  file. `maxInkStrokes` is one allowance across the file, like `maxNodes`: a room past what is left
  keeps its first strokes.
- `openPoints` is read at the root only. Targets are resolved after every room is loaded; a
  missing target is dropped, and a point with no targets left is dropped.
- A `sequence` payload is normalized by `validateSequence.ts`: messages to or from a missing
  participant, replies whose call is gone, broken nesting and anything past the sequence limits are
  dropped; a participant's `ref` to a missing shape is cleared and the participant kept.

## Limits

From `LIMITS` in `src/document/limits.ts`:

| Limit | Value |
| --- | --- |
| `maxFileBytes` | 24 MB |
| `maxNodes` / `maxEdges` | 5,000 / 10,000 |
| `maxInsideDepth` / `maxGroupDepth` | 3 / 32 |
| `maxZ` | ±10,000 (stacking order) |
| `maxAttachmentsPerNode` / `maxAttachmentsPerEdge` | 12 / 4 |
| `maxFlows` / `maxStepsPerFlow` / `maxExtraMembersPerStep` | 50 / 200 / 40 |
| `maxOpenPoints` / `maxOpenPointTargets` | 200 / 40 |
| `maxWaypointsPerEdge` | 32 |
| `maxSequenceParticipants` / `maxSequenceItems` | 40 / 600 |
| `maxSequenceDepth` / `maxSequenceOperands` / `maxSequenceGroups` | 8 / 12 / 20 |
| `maxSequenceNameLength` / `maxSequenceNoteLength` | 120 / 1,000 |
| `maxInkStrokes` / `maxInkPoints` | 4,000 per file / 2,000 per stroke |
| `maxTitleLength` / `maxLabelLength` | 200 / 500 |
| `maxTextLength` / `maxCodeLength` | 20,000 / 200,000 |
| `maxDescriptionLength` / `maxTechnologyLength` | 280 / 60 |

## Style

`style` (`DocumentStyle`, `src/document/style.ts`) is root-only and optional. Absent, the diagram
is drawn in the style in use on the device that opens it, as every file before v32 is.

| Field | Notes |
| --- | --- |
| `v` | `1`. Anything else is read as no style. |
| `name` | For display only. Nothing looks a style up by name. |
| `hand` | `base` (`clean`, `draft`, `sketch`), optional `wobble` (`calm`, `lively`) and `retrace`. |
| `general` | `weight` (`fine`, `regular`, `bold`), `corners` (`sharp`, `soft`, `round`), `shadow`, and `depth` (`deep`) for a shadow that lifts shapes further. No typeface: it would change how big a shape has to be. |
| `schemes` | `light` and `dark`, each a set of `#rrggbb` canvas colours and accent colours, and an optional `selection`: the colour that marks what is chosen. With one, the diagram is always drawn in that theme. |
| `shapes` | Keyed by shape type (`service`) or type and kind (`service:gateway`). Each entry has the `general` fields, plus `art` (an asset id), `fit` and `builtin` where a drawing applies. A kind inherits from its type, a type from `general`. |
| `connectors` | `weight`, `head` (`nib`, `triangle`), `colour` (`source`, `plain`). |
| `backdrop` | Optional: `art` (an asset id), `strength` (`faint`, `strong`) and `scale` (`small`, `large`). One drawing repeated on the canvas behind the diagram, and in exports that have a background. |
| `assets` | Custom drawings: `id`, `w`, `h` and `paths` of `d` (absolute `M`, `L`, `C`, `Z` only), `fill`, `stroke`, `sw`, `o`, `rule`. No markup is ever stored. |

`normalizeStyle` rebuilds a style from this whitelist wherever one is read: a file, a collaborator's
change, a profile or a gallery pack. A drawing that is not exactly the stored form is dropped whole, a
drawing no shape uses is dropped, and a colour that could not be read falls back when the style is
resolved (`src/render/style/scheme.ts`). Limits are `STYLE_LIMITS`: 64 drawings, 48 paths and 8,192
characters of path data each, 262,144 characters across a style.

### Style files

A `.draftstyle` file (`src/document/styleFile.ts`) is `{ "format": "draft-canvas-style", "version": 1,
"name", "style" }`, where `style` is the same `DocumentStyle`. It is read through `normalizeStyle`
like a style in a diagram. A newer `version` is refused by name.

## Serialization

- `serializeDocument` / `deserializeDocument` (`src/export/project.ts`) write and read the shape
  `parseDocument` validates. Exported files are not trusted on the way back in.
- Bytes are canonical (`src/export/canonical.ts`): keys in the order `types.ts` declares them (`id`
  first), unknown keys after them sorted, `undefined` values omitted. The same diagram always
  writes the same bytes, so `git diff` shows only real changes.
- Tests: `tests/serialization.test.ts` (round trip and canonical bytes), `tests/migrate.test.ts`
  (every transition, idempotency, chain completeness).

## Optional fields without a version bump

| Field | Notes |
| --- | --- |
| `textFont`, `textBackground` | Text nodes only. `sans`, `serif`, `mono`, `hand`; `card`, `marker`, `banner`. Absent: the role's face, no background. |
| `actorFrame` | Actors only. `borderless` or `framed`. New actors are `borderless`; absent renders framed. |

Since v21, a Text node's `text` is Markdown (`src/render/text/markdown.ts`). Every other node's
`text` is plain.
