/**
 * Open points read back off the file for review — the overview's rows, the focus set, the copy.
 *
 * A derivation over `DraftDocument.openPoints` and the elements it names, resolved through the same
 * file index Takeaways uses (`takeaways/collect.ts`), so a point about a connector two rooms down is
 * called what the rest of the product calls it and can be walked to the same way. Framework-free,
 * like everything beside `document/`.
 */

import { OPEN_POINT_LABELS, pointsOf, unresolvedIndex } from '../document/openPoints';
import type { DraftDocument, OpenPoint } from '../document/types';
import { indexFile, resolveTarget, type TakeawayTarget } from '../takeaways/collect';

export interface OpenPointRow {
  point: OpenPoint;
  /** Every element the point is about that still resolves, in the point's own order. */
  targets: TakeawayTarget[];
}

export interface OpenPointsOverview {
  open: OpenPointRow[];
  resolved: OpenPointRow[];
}

/** Every point in the file with its elements named — open ones first, in the order they were raised. */
export function openPointsOverview(file: DraftDocument): OpenPointsOverview {
  const index = indexFile(file);
  const open: OpenPointRow[] = [];
  const resolved: OpenPointRow[] = [];
  for (const point of pointsOf(file)) {
    const targets = point.targets
      .map((target) => resolveTarget(index, target.kind, target.id))
      .filter((target): target is TakeawayTarget => target !== undefined);
    (point.resolved ? resolved : open).push({ point, targets });
  }
  return { open, resolved };
}

/** What a row is called when it has no context of its own: its kind and what it is about. */
export function rowTitle(row: OpenPointRow): string {
  return row.point.context?.trim() || `${OPEN_POINT_LABELS[row.point.kind]} · ${describeTargets(row)}`;
}

/** "Payment Service, Payment Service → Ledger" — the elements a point concerns, named. */
export function describeTargets(row: OpenPointRow): string {
  return row.targets.map((target) => target.label).join(', ');
}

/**
 * The elements in one room that carry an unresolved point — what "Focus open points" lights. A
 * shared point contributes every target it has here; targets in other rooms are simply not in
 * this picture.
 */
export function unresolvedTargetsIn(view: Pick<DraftDocument, 'nodes' | 'edges'> & Partial<Pick<DraftDocument, 'openPoints'>>): { nodeIds: string[]; edgeIds: string[] } {
  const index = unresolvedIndex(view.openPoints);
  if (index.size === 0) return { nodeIds: [], edgeIds: [] };
  const nodeIds = view.nodes.filter((node) => index.has(`node:${node.id}`)).map((node) => node.id);
  const edgeIds = view.edges.filter((edge) => index.has(`edge:${edge.id}`)).map((edge) => edge.id);
  return { nodeIds, edgeIds };
}

/** Whether anything in this room wears a marker — what decides if an export offers to leave them out. */
export function hasUnresolvedIn(view: Pick<DraftDocument, 'nodes' | 'edges'> & Partial<Pick<DraftDocument, 'openPoints'>>): boolean {
  const { nodeIds, edgeIds } = unresolvedTargetsIn(view);
  return nodeIds.length + edgeIds.length > 0;
}
