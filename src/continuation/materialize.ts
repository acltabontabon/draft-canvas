import { capabilityFor, categoryOf, inferRelationship } from '../document/connectorSemantics';
import { relationshipCaptionLabel } from '../document/edgeSemantics';
import { createEdge, createNode, defaultSizeFor } from '../document/factory';
import { addNodes, COMPANION_GAP, tryPlaceNear } from '../document/operations';
import { queueTubeCenterFraction } from '../document/queueGeometry';
import type { DraftDocument, DraftEdge, DraftNode, EdgeAnchor } from '../document/types';
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
      index === 0 && options.at ? { x: Math.round(options.at.x), y: Math.round(options.at.y) } : tryPlaceNear(working, host, size, gapForCaption(caption));
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
        ...horizontalAnchorsFor(from, to),
      }),
    );
  }

  return { ...continuation, nodes, edges, primaryNodeId: nodes[0]!.id };
}

function containsRect(
  outer: Pick<DraftNode, 'x' | 'y' | 'width' | 'height'>,
  inner: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/**
 * Explicit anchors for the plain "companion placed directly to the right" case, and only that
 * case. Other placements are left to the routing system's own live nearest-side heuristic. For a
 * queue-family endpoint on the horizontal path, `offset: 0.5` would land the connector at the
 * boundary between the tube glyph and its caption below — see `queueTubeCenterFraction` — so the
 * relevant side gets an explicit offset that lands on the tube's own visual centre instead.
 */
export function horizontalAnchorsFor(
  source: Pick<DraftNode, 'x' | 'y' | 'width' | 'height' | 'type'>,
  target: Pick<DraftNode, 'x' | 'y' | 'width' | 'height' | 'type'>,
): { sourceAnchor?: EdgeAnchor; targetAnchor?: EdgeAnchor } {
  const isHorizontal = target.y === source.y && target.x >= source.x + source.width;
  if (!isHorizontal) return {};
  return {
    sourceAnchor: source.type === 'queue' ? { side: 'right', offset: queueTubeCenterFraction(source.height) } : undefined,
    targetAnchor: target.type === 'queue' ? { side: 'left', offset: queueTubeCenterFraction(target.height) } : undefined,
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
