/**
 * The single funnel for document-version handling.
 *
 * Nothing else in the codebase may branch on `version`. When the on-disk shape
 * changes, bump `CURRENT_VERSION` in `types.ts` and add one entry here that
 * takes a v(n) shaped object and returns a v(n+1) shaped one.
 */
import { createId } from './ids';
import { CURRENT_VERSION } from './types';

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
    if (typeof edge.sequence === 'number' && Number.isFinite(edge.sequence)) {
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
 * `MIGRATIONS[n]` upgrades a version-`n` document to version `n + 1`.
 */
const MIGRATIONS: Record<number, Migration> = {
  1: migrateSequenceToFlows,
  2: migrateAnchors,
  3: migrateFlowAccent,
  4: migrateBackground,
  5: migrateResponse,
  6: migrateCardAndRoundedToNote,
  7: migrateHasResponse,
  8: migrateAddProjectId,
  9: migrateAddRouteMode,
  10: migrateBffToApi,
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
