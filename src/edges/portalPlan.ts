import type { DraftEdge, DraftNode, Side } from '../document/types';

/**
 * Which side of its shape each end of a portal (`DraftEdge.portal`) sits on, and how far along it.
 *
 * A portal is two stubs and their words, with no line to follow. Left on the side the line would
 * have used, a stub lands among the connectors that really do leave there and its words are written
 * over them. So each end takes the side facing where it goes when nothing else uses that side, and
 * otherwise the nearest side that is free; several portals on one side sit a step apart. A pin the
 * person set on an end is kept.
 *
 * Read from the document, as the other plans are, and expressed against the shape (a side and a
 * shift along it), so a shape being dragged takes its stubs with it frame by frame.
 */

export interface PortalSlot {
  side: Side;
  /** Canvas units from the middle of the side, along it. */
  shift: number;
}

export interface PortalSlots {
  source: PortalSlot;
  target: PortalSlot;
}

export interface PortalPlan {
  slotsFor: (edgeId: string) => PortalSlots | undefined;
}

/** Room between two portals on the same side: a line of their words, and air. */
const STEP = 22;

const EMPTY: PortalPlan = { slotsFor: () => undefined };
const cache = new WeakMap<readonly DraftEdge[], { nodes: readonly DraftNode[]; plan: PortalPlan }>();

/** The side of `from` that faces `to`: across when they are further apart across than down. */
function facing(from: DraftNode, to: DraftNode): Side {
  const dx = to.x + to.width / 2 - (from.x + from.width / 2);
  const dy = to.y + to.height / 2 - (from.y + from.height / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'bottom' : 'top';
}

/** The sides to try, nearest the wanted one first: itself, its two neighbours, then the far side. */
function nearest(wanted: Side): Side[] {
  switch (wanted) {
    case 'right':
      return ['right', 'top', 'bottom', 'left'];
    case 'left':
      return ['left', 'top', 'bottom', 'right'];
    case 'top':
      return ['top', 'right', 'left', 'bottom'];
    case 'bottom':
      return ['bottom', 'right', 'left', 'top'];
  }
}

export function portalPlan(nodes: readonly DraftNode[], edges: readonly DraftEdge[]): PortalPlan {
  const known = cache.get(edges);
  if (known && known.nodes === nodes) return known.plan;
  const plan = edges.some((edge) => edge.portal) ? compute(nodes, edges) : EMPTY;
  cache.set(edges, { nodes, plan });
  return plan;
}

function compute(nodes: readonly DraftNode[], edges: readonly DraftEdge[]): PortalPlan {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  // The sides real lines use, by shape.
  const busy = new Map<string, Set<Side>>();
  const use = (nodeId: string, side: Side) => (busy.get(nodeId) ?? busy.set(nodeId, new Set()).get(nodeId)!).add(side);
  for (const edge of edges) {
    if (edge.portal) continue;
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) continue;
    use(source.id, edge.sourceAnchor?.side ?? facing(source, target));
    use(target.id, edge.targetAnchor?.side ?? facing(target, source));
  }
  // Portals already seated on each side of each shape, so the next one sits a step along.
  const seated = new Map<string, number>();
  const seat = (node: DraftNode, toward: DraftNode, pinned: Side | undefined): PortalSlot => {
    const taken = busy.get(node.id);
    const side = pinned ?? nearest(facing(node, toward)).find((candidate) => !taken?.has(candidate)) ?? facing(node, toward);
    const key = `${node.id}\u0000${side}`;
    const index = seated.get(key) ?? 0;
    seated.set(key, index + 1);
    // 0, +1, -1, +2, -2 … steps from the middle, kept on the side.
    const order = index === 0 ? 0 : (index % 2 === 1 ? 1 : -1) * Math.ceil(index / 2);
    const half = (side === 'top' || side === 'bottom' ? node.width : node.height) / 2 - 8;
    return { side, shift: Math.max(-half, Math.min(half, order * STEP)) };
  };
  const slots = new Map<string, PortalSlots>();
  for (const edge of edges) {
    if (!edge.portal) continue;
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) continue;
    slots.set(edge.id, { source: seat(source, target, edge.sourceAnchor?.side), target: seat(target, source, edge.targetAnchor?.side) });
  }
  return planOf(slots);
}

/** Built outside `compute`, so the plan keeps the slots and none of the scratch maps (see `bundles.ts`). */
function planOf(slots: ReadonlyMap<string, PortalSlots>): PortalPlan {
  return { slotsFor: (edgeId) => slots.get(edgeId) };
}
