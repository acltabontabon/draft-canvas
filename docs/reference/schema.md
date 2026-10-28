# Document schema and versioning

The migration and validation contract for `.draftcanvas` files. If this drifts from the code, the
code wins.

## The file

A document (`DraftDocument` in `src/document/types.ts`) is JSON with these root fields:

| Field | Contents |
| --- | --- |
| `format` | Always `"draft-canvas"` |
| `version` | Format version, currently **23** (`CURRENT_VERSION`) |
| `metadata` | `id`, `title`, `createdAt`, `updatedAt`, optional `projectId` |
| `nodes`, `edges`, `flows`, `viewport` | The top-level graph |
| `settings` | Canvas settings, including the background |
| `openPoints` | Unsettled questions attached to elements. Root only |
| `level` | Optional `ViewLevel` |

A node may own a room (`DraftNode.inside`): its own `nodes`, `edges`, `flows`, `viewport` and
optional `level`. A document is a tree of graphs, nested at most 3 levels below the root.

The same shape is stored in IndexedDB's `bodies` store.

## Versions and migrations

`src/document/migrate.ts` is the only code that reads `version`. `MIGRATIONS[n]` upgrades a
version-`n` document to `n + 1`. `migrateToCurrent` runs the chain:

- A missing `version` is treated as 1. A present but unreadable one (a string, a fraction, `null`, zero or negative) is refused, so a current file is never run through the whole chain.
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
| v4 → v5 | `migrateBackground` | No-op (canvas background) |
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
| v20 → v21 | `migrateTextToMarkdown` | Text node and Text attachment `text` is escaped so it reads the same as Markdown |
| v21 → v22 | identity | No-op (optional linked compensation fields on connectors) |
| v22 → v23 | identity | No-op (retired per-connector style overrides are discarded by normalization) |

Wrapped in `everyRoom`: the migrations from v1, v2, v6, v7, v10, v13, v17 and v20. `migrateActionsToNotes` is
root-only but walks rooms itself to resolve anchors.

Linked compensating actions remain ordinary connectors. A compensation can name its originating
interaction with `compensationFor`, keep its line folded with `compensationVisible: false`, and
carry a business name (`compensationName`), protocol (`compensationProtocol`) and optional context
(`compensationDescription`). Its ordinary `label` remains the counteraction operation. These fields
are available in MCP `create_diagram`, `read_diagram` and `update_diagram`, including through Nodi.
Older, unlinked `compensates` connectors stay visible; migration never guesses which operation they
counteract. An invalid link is removed while the action remains visible and editable.

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
- Text has control characters stripped and is length-clamped.
- Numbers are coerced to finite values and clamped.
- Collections over their limit are truncated. `maxNodes` and `maxEdges` are one allowance across
  the file, spent outermost first.
- Dangling references are dropped: edges to missing nodes, missing `parentId` boundaries, flow
  steps to missing edges.
- Rooms deeper than `maxInsideDepth` are dropped. A room with no shapes is dropped. Ids are unique
  across the whole file.
- `openPoints` is read at the root only. Targets are resolved after every room is loaded; a
  missing target is dropped, and a point with no targets left is dropped.

## Limits

From `LIMITS` in `src/document/limits.ts`:

| Limit | Value |
| --- | --- |
| `maxFileBytes` | 24 MB |
| `maxNodes` / `maxEdges` | 5,000 / 10,000 |
| `maxInsideDepth` | 3 |
| `maxAttachmentsPerNode` / `maxAttachmentsPerEdge` | 12 / 4 |
| `maxFlows` / `maxStepsPerFlow` / `maxExtraMembersPerStep` | 50 / 200 / 40 |
| `maxOpenPoints` / `maxOpenPointTargets` | 200 / 40 |
| `maxWaypointsPerEdge` | 32 |
| `maxTitleLength` / `maxLabelLength` | 200 / 500 |
| `maxTextLength` / `maxCodeLength` | 20,000 / 200,000 |
| `maxDescriptionLength` / `maxTechnologyLength` | 280 / 60 |
| `maxEmbeddedBackgroundBytes` | 2 MB |

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
| `settings.background.image` | Base64 image data URI written only by `.draftcanvas` export, up to `maxEmbeddedBackgroundBytes`. Import moves it to the image store and drops the field. |
| `textFont`, `textBackground` | Text nodes only. `sans`, `serif`, `mono`, `hand`; `card`, `marker`, `banner`. Absent: the role's face, no background. |
| `actorFrame` | Actors only. `borderless` or `framed`. New actors are `borderless`; absent renders framed. |

Since v21, a Text node's `text` is Markdown (`src/render/text/markdown.ts`). Every other node's
`text` is plain.
