import { capabilityFor, categoryOf, inferRelationship } from '../document/connectorSemantics';
import { relationshipCaptionLabel } from '../document/edgeSemantics';
import { createEdge, createNode, defaultSizeFor } from '../document/factory';
import { addNodes, COMPANION_GAP, containsRect, tryPlaceNear, type CompanionDirection } from '../document/operations';
import type { DraftDocument, DraftEdge, DraftNode, EdgeAnchor } from '../document/types';
import { chooseSides, type Rect } from '../edges/routing';
import { FONTS } from '../render/text/fonts';
import { getMeasurer } from '../render/text/measure';
import type { Continuation, MaterializedContinuation } from './types';

export interface MaterializeOptions {
  /** Top-left for the fragment's first node — the drop point when the user chose where. Otherwise
   *  the node lands where `placeNear` would put a generated companion. */
  at?: { x: number; y: number };
}

/**
 * Turns a continuation into the real nodes and connectors accepting it would add — positioned,
 * with ids, with every connector's semantics read from the capability matrix exactly as a
 * hand-drawn one would be. The preview draws this; the accept commits this; nothing is computed
 * twice, so what you see is what you get.
 *
 * Returns `undefined` when there is no clear place to put it. A suggestion that would land on
 * top of the user's own content is worse than no suggestion.
 */
export function materialize(
  doc: DraftDocument,
  continuation: Continuation,
  options: MaterializeOptions = {},
): MaterializedContinuation | undefined {
  const anchor = doc.nodes.find((n) => n.id === continuation.anchorId);
  if (!anchor) return undefined;
  const parent = anchor.parentId ? doc.nodes.find((n) => n.id === anchor.parentId) : undefined;
  // Which way the diagram is already flowing at this anchor, so a continuation's placement reads
  // as "the next step in the same direction" rather than always defaulting to the right regardless
  // of context — computed once from the anchor's own edges, not re-derived per fragment node.
  const direction = preferredDirection(doc, anchor);

  const byKey = new Map<string, DraftNode>();
  const nodes: DraftNode[] = [];
  let working = doc;
  let host: DraftNode = anchor;

  for (const [index, spec] of continuation.fragment.nodes.entries()) {
    const size = defaultSizeFor(spec.type);
    // The gap must clear the caption the connector *into* this node will carry — the same rule
    // `addConsumer`/`addDeadLetterQueue` follow, so "after 3 attempts" never overlaps either box.
    const inbound = continuation.fragment.edges.find((e) => e.to === spec.key);
    const hostForGap = inbound ? (inbound.from === 'anchor' ? anchor : byKey.get(inbound.from)) : undefined;
    const semantic = hostForGap ? capabilityFor(categoryOf(hostForGap), categoryOf(spec))?.defaultRelation : undefined;
    const caption = semantic ? relationshipCaptionLabel(semantic, undefined, inbound?.deliveryAttempts) : undefined;

    const position =
      index === 0 && options.at
        ? { x: Math.round(options.at.x), y: Math.round(options.at.y) }
        : tryPlaceNear(working, host, size, gapForCaption(caption), { direction, parent });
    if (!position) return undefined;

    const node = createNode({
      type: spec.type,
      x: position.x,
      y: position.y,
      z: anchor.z,
      text: spec.text,
      accent: spec.accent,
      serviceKind: spec.serviceKind,
      databaseKind: spec.databaseKind,
      queueKind: spec.queueKind,
      actorKind: spec.actorKind,
      componentKind: spec.componentKind,
      deliveryRole: spec.deliveryRole,
      // Stays inside the anchor's boundary only if it actually fits there — a companion poking
      // out of a boundary would silently *mean* something (membership) it visibly isn't.
      parentId: parent && containsRect(parent, { ...position, ...size }) ? parent.id : undefined,
    });
    byKey.set(spec.key, node);
    nodes.push(node);
    working = addNodes(working, [node]);
    host = node;
  }

  const edges: DraftEdge[] = [];
  for (const spec of continuation.fragment.edges) {
    const from = spec.from === 'anchor' ? anchor : byKey.get(spec.from);
    const to = spec.to === 'anchor' ? anchor : byKey.get(spec.to);
    if (!from || !to) return undefined;
    const relationship = inferRelationship(from, to);
    edges.push(
      createEdge({
        source: from.id,
        target: to.id,
        ...relationship,
        semanticsOrigin: relationship ? 'inferred' : undefined,
        deliveryAttempts: spec.deliveryAttempts,
        ...anchorsForPlacement(from, to),
      }),
    );
  }

  return { ...continuation, nodes, edges, primaryNodeId: nodes[0]!.id };
}

/** A plain `{x,y,width,height}` view of anything with those fields — `chooseSides` doesn't need a
 *  full `DraftNode`, and building a `DraftNode`-shaped object just to call it would be backwards. */
function toRect(n: Pick<DraftNode, 'x' | 'y' | 'width' | 'height'>): Rect {
  return { x: n.x, y: n.y, width: n.width, height: n.height };
}

/**
 * Which way the diagram is already flowing at `anchor`: predominantly left/right (horizontal) or
 * predominantly top/bottom (vertical), read from its existing edges' sides via the same
 * `chooseSides` a real connector's routing uses. A continuation with no direction of its own to
 * go on (a Topic with only an inbound publisher, say) continues the direction already established
 * around it instead of always defaulting rightward regardless of how the diagram is laid out.
 * Ties, and an anchor with no edges yet, default to `'right'` — today's only behaviour.
 */
function preferredDirection(doc: DraftDocument, anchor: DraftNode): CompanionDirection {
  let horizontal = 0;
  let vertical = 0;
  for (const edge of doc.edges) {
    const fromAnchor = edge.source === anchor.id;
    const toAnchor = edge.target === anchor.id;
    if (!fromAnchor && !toAnchor) continue;
    const other = doc.nodes.find((n) => n.id === (fromAnchor ? edge.target : edge.source));
    if (!other) continue;
    const sides = fromAnchor ? chooseSides(toRect(anchor), toRect(other)) : chooseSides(toRect(other), toRect(anchor));
    const anchorSide = fromAnchor ? sides.source : sides.target;
    if (anchorSide === 'left' || anchorSide === 'right') horizontal += 1;
    else vertical += 1;
  }
  return vertical > horizontal ? 'below' : 'right';
}

/**
 * The anchors a continuation's own connector should be pinned to — computed once, here, and
 * carried on the created edge so the ghost that previews it and the edge that results from
 * accepting it resolve to the exact same route. Uses the same `chooseSides` real, hand-drawn
 * connectors resolve dynamically against, so a pinned continuation edge looks exactly like one
 * `chooseSides` would have picked anyway; the difference is only that this locks it in rather
 * than leaving both preview and real edge to (hopefully) agree by recomputing it twice.
 */
export function anchorsForPlacement(
  source: Pick<DraftNode, 'x' | 'y' | 'width' | 'height' | 'type'>,
  target: Pick<DraftNode, 'x' | 'y' | 'width' | 'height' | 'type'>,
): { sourceAnchor: EdgeAnchor; targetAnchor: EdgeAnchor } {
  const { source: sourceSide, target: targetSide } = chooseSides(toRect(source), toRect(target));
  return {
    sourceAnchor: { side: sourceSide, offset: 0.5 },
    targetAnchor: { side: targetSide, offset: 0.5 },
  };
}

/**
 * Explicit anchors for the plain "companion placed directly to the right" case, and only that
 * case — used by `addConsumer`/`addDeadLetterQueue`, which (unlike Intent Continuation's own
 * `anchorsForPlacement` above) still want dynamic, unpinned routing everywhere else. Kept
 * unchanged and separate rather than folded into the general version, so generalizing continuation
 * edges' anchors doesn't also change those two commands' existing, already-tested behaviour.
 */
export function horizontalAnchorsFor(
  source: Pick<DraftNode, 'x' | 'y' | 'width' | 'height' | 'type'>,
  target: Pick<DraftNode, 'x' | 'y' | 'width' | 'height' | 'type'>,
): { sourceAnchor?: EdgeAnchor; targetAnchor?: EdgeAnchor } {
  const isHorizontal = target.y === source.y && target.x >= source.x + source.width;
  if (!isHorizontal) return {};
  return {
    // Pinning the side (not the offset) is all a queue-family end needs: routing itself lands a
    // left/right anchor on the tube band (`anchorBandOf`), so the plain midpoint is the glyph's.
    sourceAnchor: source.type === 'queue' ? { side: 'right', offset: 0.5 } : undefined,
    targetAnchor: target.type === 'queue' ? { side: 'left', offset: 0.5 } : undefined,
  };
}

/** Comfortable clearance on each side of a connector's own caption, so it never reads as crowding
 *  either endpoint it sits between. */
const CAPTION_CLEARANCE = 16;

/**
 * How far apart a generated companion needs to land so its connector's own caption — "after 3
 * attempts", "consumes", … — fits in the gap without overlapping either node, given the plain
 * horizontal placement `placeNear` prefers puts the caption right in the middle of that gap.
 * Never smaller than the default companion spacing, so a short/absent caption keeps the compact
 * placement exactly as it was.
 */
export function gapForCaption(caption: string | undefined): number {
  if (!caption) return COMPANION_GAP;
  const width = getMeasurer().width(caption, FONTS.connectorCaption);
  return Math.max(COMPANION_GAP, width + CAPTION_CLEARANCE * 2);
}
