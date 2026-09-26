/**
 * The single funnel for document-version handling.
 *
 * Nothing else in the codebase may branch on `version`. When the on-disk shape
 * changes, bump `CURRENT_VERSION` in `types.ts` and add one entry here that
 * takes a v(n) shaped object and returns a v(n+1) shaped one.
 */
import { createId } from './ids';
import { LIMITS } from './limits';
import { CURRENT_VERSION } from './types';
import { isFiniteNumber } from '../lib/math';

type Migration = (doc: Record<string, unknown>) => Record<string, unknown>;

/**
 * v1's single, document-wide numbered walkthrough (`edge.sequence`) becomes a
 * single named Flow in v2, so an existing walkthrough keeps working exactly
 * as it looked before — multiple, independently-orderable flows are new, but
 * nothing that already existed is lost. Edges lose their `sequence` field;
 * order now lives entirely in the flow's `steps`.
 */
function migrateSequenceToFlows(doc: Record<string, unknown>): Record<string, unknown> {
  const edges = Array.isArray(doc.edges) ? doc.edges : [];
  const sequenced: { id: unknown; sequence: number }[] = [];
  for (const raw of edges) {
    if (!raw || typeof raw !== 'object') continue;
    const edge = raw as Record<string, unknown>;
    if (isFiniteNumber(edge.sequence)) {
      sequenced.push({ id: edge.id, sequence: edge.sequence });
    }
  }
  sequenced.sort((a, b) => a.sequence - b.sequence);

  const strippedEdges = edges.map((raw) => {
    if (!raw || typeof raw !== 'object') return raw;
    const { sequence: _drop, ...rest } = raw as Record<string, unknown>;
    return rest;
  });

  const existingFlows = Array.isArray(doc.flows) ? doc.flows : [];
  const flows =
    sequenced.length > 0
      ? [
          ...existingFlows,
          {
            id: createId('f'),
            title: 'Walkthrough',
            steps: sequenced.map((entry) => ({ id: createId('fs'), edgeId: entry.id })),
          },
        ]
      : existingFlows;

  return { ...doc, edges: strippedEdges, flows };
}

type Side = 'top' | 'right' | 'bottom' | 'left';
interface RawRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A frozen copy of the nearest-side heuristic `edges/routing.ts`'s
 * `chooseSides` used at the moment anchors were introduced (v3) — not an
 * import of that function. `document/` must never depend on `edges/`, and a
 * migration has to reproduce what it did at the time it ran, unchanged, even
 * if the live heuristic is later refined for unrelated reasons.
 */
function nearestSides(source: RawRect, target: RawRect): { source: Side; target: Side } {
  const dx = target.x + target.width / 2 - (source.x + source.width / 2);
  const dy = target.y + target.height / 2 - (source.y + source.height / 2);
  const gapX = Math.abs(dx) - (source.width + target.width) / 2;
  const gapY = Math.abs(dy) - (source.height + target.height) / 2;
  if (gapX >= gapY) {
    return dx >= 0 ? { source: 'right', target: 'left' } : { source: 'left', target: 'right' };
  }
  return dy >= 0 ? { source: 'bottom', target: 'top' } : { source: 'top', target: 'bottom' };
}

function rectOf(raw: unknown): RawRect | null {
  if (!raw || typeof raw !== 'object') return null;
  const { x, y, width, height } = raw as Record<string, unknown>;
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height)
  ) {
    return null;
  }
  return { x, y, width, height };
}

/**
 * v2 has no concept of a connector anchor at all — routing always picked the
 * nearest sides itself, live, on every render. Deriving one now and
 * persisting it keeps a migrated document's on-screen appearance
 * byte-identical to before migration (the same heuristic that already ran
 * live), while satisfying "computed once, then persisted, not silently
 * re-derived every load" going forward. A dangling edge (an endpoint that no
 * longer resolves to a node) is left alone — `document/validate.ts` drops it
 * the same way it always has, migrated or not.
 */
function migrateAnchors(doc: Record<string, unknown>): Record<string, unknown> {
  const rawNodes = Array.isArray(doc.nodes) ? doc.nodes : [];
  const nodesById = new Map<unknown, unknown>();
  for (const raw of rawNodes) {
    if (raw && typeof raw === 'object' && 'id' in raw) nodesById.set((raw as Record<string, unknown>).id, raw);
  }

  const rawEdges = Array.isArray(doc.edges) ? doc.edges : [];
  const edges = rawEdges.map((raw) => {
    if (!raw || typeof raw !== 'object') return raw;
    const edge = raw as Record<string, unknown>;
    if (edge.sourceAnchor && edge.targetAnchor) return edge;

    const sourceRect = rectOf(nodesById.get(edge.source));
    const targetRect = rectOf(nodesById.get(edge.target));
    if (!sourceRect || !targetRect) return edge;

    const sides = nearestSides(sourceRect, targetRect);
    return {
      ...edge,
      sourceAnchor: edge.sourceAnchor ?? { side: sides.source, offset: 0.5 },
      targetAnchor: edge.targetAnchor ?? { side: sides.target, offset: 0.5 },
    };
  });

  return { ...doc, edges };
}

/**
 * v3 has no concept of a flow accent at all — a flow simply has none, and
 * every version before v4 rendered it exactly the same way: each member
 * connector kept its own normal styling. There is no v3 data to derive an
 * accent from, so this migration is a structural no-op; it exists as an
 * explicit entry anyway so `migrateToCurrent`'s "every version has an entry"
 * invariant holds, and so a future migration author has a template if v4
 * ever needs a real backfill added retroactively.
 */
function migrateFlowAccent(doc: Record<string, unknown>): Record<string, unknown> {
  return doc;
}

/**
 * v4 has no concept of a canvas background at all — same structural-no-op
 * shape as `migrateFlowAccent`. `document/validate.ts`'s `normalizeDocument`
 * gives every migrated document a clean, disabled default background block;
 * there is no v4 data to derive one from.
 */
function migrateBackground(doc: Record<string, unknown>): Record<string, unknown> {
  return doc;
}

/**
 * v5 has no concept of a request/response connector at all — same
 * structural-no-op shape as `migrateFlowAccent`/`migrateBackground`. There is
 * no v5 data to derive a `response` string from.
 */
function migrateResponse(doc: Record<string, unknown>): Record<string, unknown> {
  return doc;
}

/**
 * v7 has no independent concept of "the reply line exists" — presence of
 * `response` text was the only signal. Every v7 edge that already has
 * `response` text keeps its visible line via `hasResponse: true`; every
 * other edge gets no line, exactly as it rendered before this field existed.
 */
function migrateHasResponse(doc: Record<string, unknown>): Record<string, unknown> {
  const rawEdges = Array.isArray(doc.edges) ? doc.edges : [];
  const edges = rawEdges.map((raw) => {
    if (!raw || typeof raw !== 'object') return raw;
    const edge = raw as Record<string, unknown>;
    if (typeof edge.response !== 'string' || edge.response.trim() === '') return edge;
    return { ...edge, hasResponse: true };
  });
  return { ...doc, edges };
}

/**
 * v6 removed the `card` and `rounded` node types — Draft Canvas no longer has
 * a blank, semantics-free box primitive. The closest surviving primitive is
 * `note`: it holds free text with no structural implications (no boundary,
 * no service/database/queue kind, no language). This migration retypes any
 * `card`/`rounded` node — and any `card`/`rounded` attachment folded into a
 * node or edge — to `note`, leaving every other field (text, position, size,
 * accent) untouched.
 */
function migrateCardAndRoundedToNote(doc: Record<string, unknown>): Record<string, unknown> {
  const retype = (raw: unknown): unknown => {
    if (!raw || typeof raw !== 'object') return raw;
    const item = raw as Record<string, unknown>;
    if (item.type !== 'card' && item.type !== 'rounded') return item;
    return { ...item, type: 'note' };
  };

  const retypeAttachments = (raw: unknown): unknown => {
    if (!raw || typeof raw !== 'object') return raw;
    const item = raw as Record<string, unknown>;
    if (!Array.isArray(item.attachments)) return item;
    return { ...item, attachments: item.attachments.map(retype) };
  };

  const rawNodes = Array.isArray(doc.nodes) ? doc.nodes : [];
  const nodes = rawNodes.map((raw) => retypeAttachments(retype(raw)));

  const rawEdges = Array.isArray(doc.edges) ? doc.edges : [];
  const edges = rawEdges.map((raw) => retypeAttachments(raw));

  return { ...doc, nodes, edges };
}

/**
 * v8 has no concept of a Project at all — same structural-no-op shape as
 * `migrateFlowAccent`/`migrateBackground`. An absent `metadata.projectId`
 * already means Unorganized, so there is nothing to backfill.
 */
function migrateAddProjectId(doc: Record<string, unknown>): Record<string, unknown> {
  return doc;
}

/**
 * v9 has no `routeMode` on any connector — the same structural no-op shape as
 * `migrateAddProjectId` above. Absent already means Smart Routing, which is
 * exactly how every v9 connector should behave, so there is nothing to
 * backfill. The entry exists so the funnel stays total: without it a v9 file
 * could silently mean either "before the field" or "after it".
 */
function migrateAddRouteMode(doc: Record<string, unknown>): Record<string, unknown> {
  return doc;
}

/**
 * v11 removed the `bff` Service kind — a Backend for Frontend is an architectural role, not a
 * distinct runtime primitive, and is now represented as a plain `api` Service (label, position,
 * and connections carry the role instead). This migration retypes any Service node's
 * `serviceKind: 'bff'` to `'api'`, leaving every other field untouched.
 */
function migrateBffToApi(doc: Record<string, unknown>): Record<string, unknown> {
  const retype = (raw: unknown): unknown => {
    if (!raw || typeof raw !== 'object') return raw;
    const item = raw as Record<string, unknown>;
    if (item.type !== 'service' || item.serviceKind !== 'bff') return item;
    return { ...item, serviceKind: 'api' };
  };
  const rawNodes = Array.isArray(doc.nodes) ? doc.nodes : [];
  return { ...doc, nodes: rawNodes.map(retype) };
}

/**
 * v14 removed the `projects` relationship — a projection's write into a read store is a write, and
 * says so with `writes` like every other one; the role belongs to the label, the shapes and the
 * layout. This retypes any connector's `semantic: 'projects'` to `'writes'`, leaving every other
 * field (including whether the semantic was inferred or chosen) untouched.
 */
function migrateProjectsToWrites(doc: Record<string, unknown>): Record<string, unknown> {
  const retype = (raw: unknown): unknown => {
    if (!raw || typeof raw !== 'object') return raw;
    const item = raw as Record<string, unknown>;
    return item.semantic === 'projects' ? { ...item, semantic: 'writes' } : item;
  };
  const rawEdges = Array.isArray(doc.edges) ? doc.edges : [];
  return { ...doc, edges: rawEdges.map(retype) };
}

/**
 * v12 lets a node own the architecture that runs inside it (`DraftNode.inside`). Structurally a
 * no-op — a v11 node simply has no inside, which is exactly what absent already means — but the
 * version still has to move, and for a reason worth stating: a v11 build's validator rebuilds
 * every node from a field whitelist, so it would silently strip the rooms out of a v12 file and,
 * where every edit writes straight back to disk, save the stripped version over it. Refusing the file by name is the
 * only safe reading an older build can give it.
 *
 * Note for whoever adds v13: a migration that touches nodes, edges or flows has to reach every
 * room, not just the document's own graph. Wrap it in `everyRoom` when you add it to
 * `MIGRATIONS`; `migrate.test.ts` checks that every wrapped migration reaches all three levels.
 */
function migrateAddInsides(doc: Record<string, unknown>): Record<string, unknown> {
  return doc;
}

/**
 * v13 gave a document its canvas-level `actions` — what the meeting decided somebody has to do
 * next. The field was removed again in v17 (`migrateActionsToNotes`), but this entry stays: the
 * chain has no gaps, and a v12 file still has to pass through here. Structurally a no-op: a v12 file simply has none, and `normalizeDocument`
 * fills in the empty list every document without one already means.
 *
 * Document-wide, so deliberately **not** wrapped in `everyRoom`: actions are root-only, like
 * `settings`. A room is a room, but the meeting is the file.
 *
 * The version still moves, for the same reason v12's did: a v12 build's validator rebuilds the
 * document from a field whitelist, so it would quietly drop the actions out of a v13 file and —
 * where every edit writes straight back to disk — save the stripped version over the
 * original. Refusing the file by name is the only safe reading an older build can give it.
 */
function migrateAddActions(doc: Record<string, unknown>): Record<string, unknown> {
  return doc;
}

/**
 * v15 lets an architecture shape carry a C4 `description` and `technology`. Structurally a no-op:
 * a v14 file has neither, and a shape without them draws exactly as it did.
 *
 * Not wrapped in `everyRoom`, because there is nothing to rewrite at any level. The version moves
 * for v13's reason: a v14 build's whitelist would silently strip both fields and, where every edit
 * saves straight back to disk, write the stripped file over the original.
 */
function migrateAddC4Text(doc: Record<string, unknown>): Record<string, unknown> {
  return doc;
}

/**
 * v16 gives a document its canvas-level `openPoints` — what the discussion has not settled yet,
 * attached to the shapes and connectors it concerns (`OpenPoint`). Structurally a no-op: a v15 file
 * simply has none, and `normalizeDocument` fills in the empty list every document without one
 * already means. Root-only like `actions`, so deliberately **not** wrapped in `everyRoom`.
 *
 * The version moves for v13's reason: a v15 build's whitelist would silently strip the points out of
 * a v16 file and, where every edit saves straight back to disk, write the stripped file over the
 * original. Refusing the file by name is the only safe reading an older build can give it.
 */
function migrateAddOpenPoints(doc: Record<string, unknown>): Record<string, unknown> {
  return doc;
}

/**
 * v17 removes canvas-level `actions` (the Takeaways list, v13–v16) and turns each one into a note,
 * so nothing anybody wrote down is lost when the panel goes away:
 *
 * - an action anchored to a shape or connector that still exists — at the root or inside any room,
 *   which is where Takeaways resolved anchors too — becomes a note *attachment* on that element,
 *   `Action: …` or `Done: …`, so the reference stays a real reference rather than a name in prose;
 * - everything else (no anchor, an anchor to something deleted, or a host already carrying as many
 *   attachments as it may) is gathered into one `Actions` note node placed just below the root
 *   graph, one line per action with a ☐/☑ box, split into a second note only past the text limit.
 *
 * Root-only entry (the field was root-only), but it walks rooms itself to find anchors. Runs on raw
 * records and mints fresh ids: an action's own `a_…` id shares the attachment prefix and the
 * validator dedupes ids file-wide, so reusing one could collide. The caps and sizes are frozen here
 * rather than read from `LIMITS`/`DEFAULTS`, for `nearestSides`' reason: a migration reproduces
 * what the app did at the time, not what it does later.
 */
const V17_MAX_ATTACHMENTS_PER_NODE = 12;
const V17_MAX_ATTACHMENTS_PER_EDGE = 4;
const V17_MAX_NOTE_TEXT = 20_000;
const V17_NOTE_WIDTH = 200;
const V17_NOTE_MIN_HEIGHT = 56;
const V17_NOTE_LINE_HEIGHT = 18;
const V17_NOTE_MAX_HEIGHT = 2_000;

function migrateActionsToNotes(doc: Record<string, unknown>): Record<string, unknown> {
  const { actions: rawActions, ...rest } = doc;
  if (!Array.isArray(rawActions) || rawActions.length === 0) return rest;

  type Host = { record: Record<string, unknown>; max: number };
  const hosts = new Map<string, Host>();
  // Anchors are found by id, file-wide, exactly as `resolveTarget` found them: rooms included, bounded
  // the way `mapGraphs` bounds itself so a hostile file cannot make this recurse without end.
  const index = (graph: Record<string, unknown>, depth: number): void => {
    if (depth > LIMITS.maxInsideDepth) return;
    for (const raw of Array.isArray(graph.nodes) ? graph.nodes : []) {
      if (!raw || typeof raw !== 'object') continue;
      const node = raw as Record<string, unknown>;
      if (typeof node.id === 'string' && !hosts.has(node.id)) hosts.set(node.id, { record: node, max: V17_MAX_ATTACHMENTS_PER_NODE });
      if (node.inside && typeof node.inside === 'object') index(node.inside as Record<string, unknown>, depth + 1);
    }
    for (const raw of Array.isArray(graph.edges) ? graph.edges : []) {
      if (!raw || typeof raw !== 'object') continue;
      const edge = raw as Record<string, unknown>;
      if (typeof edge.id === 'string' && !hosts.has(edge.id)) hosts.set(edge.id, { record: edge, max: V17_MAX_ATTACHMENTS_PER_EDGE });
    }
  };
  index(rest, 0);

  const lines: string[] = [];
  for (const raw of rawActions) {
    if (!raw || typeof raw !== 'object') continue;
    const action = raw as Record<string, unknown>;
    const text = typeof action.text === 'string' ? action.text.trim() : '';
    if (!text) continue;
    const done = action.done === true;
    const anchor = action.anchor && typeof action.anchor === 'object' ? (action.anchor as Record<string, unknown>) : null;
    const host = anchor && typeof anchor.id === 'string' ? hosts.get(anchor.id) : undefined;
    if (host) {
      const attachments = Array.isArray(host.record.attachments) ? host.record.attachments : [];
      if (attachments.length < host.max) {
        host.record.attachments = [
          ...attachments,
          { id: createId('a'), type: 'note', noteKind: 'note', text: `${done ? 'Done' : 'Action'}: ${text}` },
        ];
        continue;
      }
    }
    lines.push(`${done ? '☑' : '☐'} ${text}`);
  }
  if (lines.length === 0) return rest;

  // Below everything at the root, aligned with its left edge; the origin when there is nothing yet.
  let minX = Infinity;
  let maxBottom = -Infinity;
  for (const raw of Array.isArray(rest.nodes) ? rest.nodes : []) {
    const rect = rectOf(raw);
    if (!rect) continue;
    minX = Math.min(minX, rect.x);
    maxBottom = Math.max(maxBottom, rect.y + rect.height);
  }
  const x = Number.isFinite(minX) ? minX : 0;
  let y = Number.isFinite(maxBottom) ? maxBottom + 40 : 0;

  const notes: Record<string, unknown>[] = [];
  let chunk: string[] = ['Actions'];
  let length = chunk[0]!.length;
  const flush = () => {
    if (chunk.length <= 1) return;
    const height = Math.min(V17_NOTE_MAX_HEIGHT, Math.max(V17_NOTE_MIN_HEIGHT, chunk.length * V17_NOTE_LINE_HEIGHT + 20));
    notes.push({ id: createId('n'), type: 'note', noteKind: 'note', x, y, width: V17_NOTE_WIDTH, height, z: 0, text: chunk.join('\n') });
    y += height + 24;
    chunk = ['Actions'];
    length = chunk[0]!.length;
  };
  for (const line of lines) {
    if (length + 1 + line.length > V17_MAX_NOTE_TEXT) flush();
    chunk.push(line);
    length += 1 + line.length;
  }
  flush();

  return { ...rest, nodes: [...(Array.isArray(rest.nodes) ? rest.nodes : []), ...notes] };
}

/**
 * Applies `fn` to the document's own graph and to every room nested inside it, however deep.
 *
 * Exists so a migration can say what it changes once and have it reach the whole file — which
 * since v12 every migration that touches nodes, edges or flows has to. Rooms are plain graphs
 * (`{nodes, edges, flows, viewport}`), so `fn` sees the same shape at every level; anything
 * unreadable is passed through untouched for `validate.ts` to repair.
 *
 * Bounded, because this runs *before* validation: the depth cap is enforced there, so an
 * imported file nested a hundred thousand deep would otherwise reach a validator that never got
 * to say no. Past the cap the room is left exactly as it came in, and validation drops it.
 */
export function mapGraphs(
  doc: Record<string, unknown>,
  fn: (graph: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  const visit = (graph: Record<string, unknown>, depth: number): Record<string, unknown> => {
    if (depth > LIMITS.maxInsideDepth) return graph;
    const mapped = fn(graph);
    const nodes = Array.isArray(mapped.nodes) ? mapped.nodes : undefined;
    if (!nodes) return mapped;
    return {
      ...mapped,
      nodes: nodes.map((raw) => {
        if (!raw || typeof raw !== 'object') return raw;
        const node = raw as Record<string, unknown>;
        if (!node.inside || typeof node.inside !== 'object') return node;
        return { ...node, inside: visit(node.inside as Record<string, unknown>, depth + 1) };
      }),
    };
  };
  return visit(doc, 0);
}

/**
 * Wraps a migration so it reaches every room, not just the document's own graph.
 *
 * The tax `DraftNode.inside` introduced, paid in one place: anything in `MIGRATIONS` that reads
 * or rewrites `nodes`, `edges` or `flows` goes through here, and `migrate.test.ts` proves each of
 * them reaches the root and all three levels below it. A migration that only touches `metadata`
 * or `settings` is document-wide and must not be wrapped.
 */
function everyRoom(migration: Migration): Migration {
  return (doc) => mapGraphs(doc, migration);
}

/**
 * `MIGRATIONS[n]` upgrades a version-`n` document to version `n + 1`.
 */
const MIGRATIONS: Record<number, Migration> = {
  1: everyRoom(migrateSequenceToFlows),
  2: everyRoom(migrateAnchors),
  3: migrateFlowAccent,
  4: migrateBackground,
  5: migrateResponse,
  6: everyRoom(migrateCardAndRoundedToNote),
  7: everyRoom(migrateHasResponse),
  8: migrateAddProjectId,
  9: migrateAddRouteMode,
  10: everyRoom(migrateBffToApi),
  11: migrateAddInsides,
  12: migrateAddActions,
  13: everyRoom(migrateProjectsToWrites),
  14: migrateAddC4Text,
  15: migrateAddOpenPoints,
  16: migrateActionsToNotes,
};

export class UnsupportedVersionError extends Error {
  readonly version: number;

  constructor(version: number) {
    super(
      `This file was made with a newer version of Draft Canvas (document format v${version}, this app reads up to v${CURRENT_VERSION}).`,
    );
    this.version = version;
    this.name = 'UnsupportedVersionError';
  }
}

export function migrateToCurrent(raw: Record<string, unknown>): {
  doc: Record<string, unknown>;
  applied: number[];
} {
  const rawVersion = typeof raw.version === 'number' ? raw.version : 1;
  // A non-integer or out-of-range version (corruption, a hand edit) is
  // treated as the oldest known format — and, critically, still runs the
  // full migration chain below rather than jumping straight past it:
  // `normalizeDocument` only recognises the *current* field layout, so a
  // genuinely old-shaped document landing here unmigrated would have its
  // old field names silently unrecognised instead of repaired.
  const version = Number.isInteger(rawVersion) && rawVersion >= 1 ? rawVersion : 1;
  if (version > CURRENT_VERSION) throw new UnsupportedVersionError(version);

  let doc = raw;
  const applied: number[] = [];
  for (let v = version; v < CURRENT_VERSION; v += 1) {
    const migration = MIGRATIONS[v];
    if (!migration) {
      throw new Error(`Missing migration from document format v${v} to v${v + 1}.`);
    }
    doc = migration(doc);
    applied.push(v);
  }
  return { doc: { ...doc, version: CURRENT_VERSION }, applied };
}
