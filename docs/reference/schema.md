# Document schema and versioning

The `.draftcanvas` file format: its fields, versioning, validation and limits. Where this page and
the code disagree, the code wins.

## The file

A document (`DraftDocument` in `src/document/types.ts`) is JSON. IndexedDB's `bodies` store holds
the same shape.

| Field | Contents |
| --- | --- |
| `format` | Always `"draft-canvas"` |
| `version` | Format version, currently **34** (`CURRENT_VERSION`) |
| `metadata` | `id`, `title`, `createdAt`, `updatedAt`, optional `projectId`, optional `origin` (`starter`, `sha256`: the gallery starter it began as) |
| `nodes`, `edges`, `flows`, `viewport` | The top-level graph |
| `ink` | Optional handwritten strokes (`DraftInk`). Absent when there are none |
| `settings` | Canvas settings: the grid and whether a flow's step badges show |
| `openPoints` | Unsettled questions attached to elements. Root only |
| `level` | Optional `ViewLevel` |
| `style` | Optional: how the diagram is drawn ([Style](#style)). Root only |

- A node may own a room (`DraftNode.inside`): its own `nodes`, `edges`, `flows`, `viewport`, and
  optional `ink` and `level`. Rooms nest at most 3 levels below the root.
- A `sequence` node's payload (`DraftSequence`) holds no coordinates: layout, work bars and the
  node's size are derived. Ids inside it are local to the node. A participant's optional `ref` is
  the id of the shape it stands for, in the same view. A canvas connector attaches to a participant
  through `sourceAnchor.participantId` or `targetAnchor.participantId`, with its offset measured
  along the lifeline.
- A Junction (a node of type `ellipse`) may carry `link`, an opaque id of at most 128 characters.
  Junctions with the same `link`, in any room, are one continuation point drawn in several places.
  `link` is never a node id and is read on its own: a link no other Junction shares is valid. Each
  linked Junction's label is its own `text`.
- A Text node's `text` is Markdown (`src/render/text/markdown.ts`); the migration to v21 escaped
  older Text nodes and attachments to read the same. Every other node's `text` is plain.
- `textFont` and `textBackground` on Text nodes, and `actorFrame` on Actors, came without a version
  bump. Absent, a Text node uses its role's face with no background, and an Actor is drawn framed;
  new Actors are `borderless`.
- A shape or connector may carry `evidence` (`SourceEvidence`, `src/document/evidence.ts`): up to 8
  references to where it comes from in a repository. Each has a repository-relative `path`, a
  `basis` of `observed` or `inferred`, and optionally a `symbol`, `line`, `commit` and
  `explanation`. A reference names code; it grants no access to it and is never fetched. An entry
  with an absolute path, a `..` segment or an unknown field is dropped. Whether a reference still
  holds is checked, never stored ([Checking a diagram](../guides/checking-a-diagram.md)).
- Compensating actions are ordinary `compensates` connectors, and `compensationFor` links one to the
  interaction it counteracts. An invalid link is removed and the action kept. Older unlinked ones
  stay unlinked: migration never guesses which operation they counteract.

## Versions and migrations

`src/document/migrate.ts` is the only code that reads `version`. `MIGRATIONS[n]` upgrades a
version-`n` document to `n + 1`, and `migrateToCurrent` runs the chain:

- A missing `version` is read as 1. A present but unreadable one (a string, a fraction, `null`, zero
  or negative) is refused, so a current file never runs through the whole chain.
- A version newer than `CURRENT_VERSION` throws `UnsupportedVersionError`, naming both versions.
- A gap in the chain throws `Missing migration from document format v${v} to v${v + 1}.`

A new version bumps `CURRENT_VERSION` and adds exactly one `MIGRATIONS` entry, even a no-op. A
migration that touches nodes, edges or flows must reach every room: write it for one graph and wrap
it with `everyRoom`. A new field that an older build's validation would strip still needs a bump, so
the older build refuses the file instead of silently writing back a stripped copy.

## Validation

`parseDocument()` (`src/document/validate.ts`) is the only way a document enters the app: file open
and import, IndexedDB load, decrypted `.dcenc` import and clipboard paste. It repairs rather than
rejects, and reports each repair to the caller.

It rejects input over `maxFileBytes`, invalid JSON, a missing `"draft-canvas"` format marker and a
newer `version`. After migration:

- Invalid enum values fall back or are dropped, and numbers are made finite and clamped.
- Text loses control characters and is length-clamped. A title, connector label, description or
  technology is also trimmed, and absent when nothing is left; a technology stays on one line, and a
  title is never cut mid-emoji. The editor writes these fields the same way, so a save holds what
  the next open keeps.
- Collections over their limit are truncated. `maxNodes`, `maxEdges`, `maxFlows` and
  `maxInkStrokes` are each one allowance across the file, spent outermost first.
- Dangling references are dropped: edges to missing nodes, missing `parentId` boundaries, flow steps
  to missing edges. `openPoints` is read at the root only, and its targets are resolved after every
  room is loaded; a missing target is dropped, and so is a point left with none. A sequence
  participant's `ref` to a missing shape is cleared, and the participant kept.
- Boundaries nested deeper than `maxGroupDepth` lose the link (the editor refuses to nest that
  deep). Rooms deeper than `maxInsideDepth` are dropped, and so is a room with no shapes.
- Shape, connector, flow and ink-stroke ids are unique across the file; a flow step's id within its
  flow, and an attachment's within its shape or connector. A missing or repeated id gets a new one.
- An ink stroke with an unknown `tool` or unreadable points is dropped, and a `pressure` list that
  doesn't match the points is removed. A sequence loses messages to or from a missing participant,
  replies whose call is gone, broken nesting and anything past its limits (`validateSequence.ts`).

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

`style` (`DocumentStyle`, `src/document/style.ts`) is optional and root-only. Without one, the
diagram is drawn in the style in use on the device that opens it.

- `v` must be `1`; anything else is read as no style. `name` is for display only: nothing looks a
  style up by name.
- There is no typeface setting: it would change how big a shape has to be.
- `schemes` holds `light` and `dark` colours. With only one of the two, the diagram is always drawn
  in that theme.
- `shapes` is keyed by type (`service`) or type and kind (`service:gateway`). A kind inherits from
  its type, and a type from `general`.
- `assets` are custom drawings, stored as path data only: absolute `M`, `L`, `C` and `Z`, with every
  point within one `w` across and one `h` down of the drawing's own box. No markup is ever stored.

`normalizeStyle` rebuilds a style from a whitelist wherever one is read: a file, a collaborator's
change, a profile or a gallery pack. A drawing not exactly in the stored form is dropped whole,
except that a point past the drawing's reach is held to that reach. A drawing no shape uses is
dropped. A colour that can't be read falls
back when the style is resolved (`src/render/style/scheme.ts`). `STYLE_LIMITS` allows 64 drawings,
48 paths and 8,192 characters of path data per drawing, and 262,144 characters across a style.

A `.draftstyle` file (`src/document/styleFile.ts`) is
`{ "format": "draft-canvas-style", "version": 1, "name", "style" }`, read through `normalizeStyle`.
A newer `version` is refused by name.

## Serialization

`serializeDocument` and `deserializeDocument` (`src/export/project.ts`) write and read what
`parseDocument` validates; an exported file is not trusted on the way back in. Bytes are canonical
(`src/export/canonical.ts`): keys in the order `types.ts` declares them (`id` first), unknown keys
after them sorted, `undefined` values omitted. The same diagram always writes the same bytes, so
`git diff` shows only real changes.
