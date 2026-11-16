/**
 * Putting a shape into the middle of a connector, and taking one back out of the middle of a line.
 * The two halves of the same edit: `A → B` with a Queue dropped on it becomes `A → Q → B`, and
 * deleting a Gateway from `Client → Gateway → API` with its lines kept gives `Client → API` again.
 * Both keep what was said about the connector — its label, attachments, flows and open points —
 * and both let the capability matrix decide what each new connector means, so a Queue spliced in
 * reads as an asynchronous command in and a consume out without anything here knowing that.
 */

import { createEdge } from './factory';
import { mergeEdgesInFlows, spliceEdgeInFlows } from './flow';
import { retargetOpenPoints } from './openPoints';
import { addEdges, removeElements } from './operations';
import { reinferIfEligible } from './reinfer';
import type { DraftDocument, DraftEdge, DraftNode } from './types';

/** Shapes that make sense standing in the middle of a connection: something a message passes
 *  through. Actors, boundaries, text, notes and code never do. */
const SPLICEABLE_TYPES: ReadonlySet<DraftNode['type']> = new Set(['service', 'database', 'queue', 'component', 'ellipse']);

export function canSpliceType(type: DraftNode['type']): boolean {
  return SPLICEABLE_TYPES.has(type);
}

/** Whether `nodeId` could be put into `edgeId` right now: both exist, the shape is a kind that
 *  passes messages on, it is neither end of the connector, and it isn't wired to either end
 *  already (the legs would duplicate a connector that exists). */
export function canSpliceInto(doc: DraftDocument, edgeId: string, nodeId: string): boolean {
  const edge = doc.edges.find((e) => e.id === edgeId);
  const node = doc.nodes.find((n) => n.id === nodeId);
  if (!edge || !node || !canSpliceType(node.type)) return false;
  if (edge.source === nodeId || edge.target === nodeId) return false;
  if (!doc.nodes.some((n) => n.id === edge.source) || !doc.nodes.some((n) => n.id === edge.target)) return false;
  return !doc.edges.some(
    (e) =>
      (e.source === edge.source && e.target === nodeId) ||
      (e.source === nodeId && e.target === edge.target),
  );
}

/** What was written about a connector, carried onto the leg that now tells it. Not the response
 *  fields: a shape in between makes the hop a relay, not a request with an answer. */
function carried(from: DraftEdge): Partial<DraftEdge> {
  const fields: Partial<DraftEdge> = {};
  if (from.label) fields.label = from.label;
  if (from.condition) fields.condition = from.condition;
  if (from.accent !== undefined) fields.accent = from.accent;
  if (from.attachments) fields.attachments = from.attachments;
  if (from.details) fields.details = from.details;
  if (from.evidence) fields.evidence = from.evidence;
  return fields;
}

/**
 * `A → B` becomes `A → node → B`. The leg into the node carries the connector's label,
 * attachments, details and evidence; flows that told `A → B` now tell both legs; an open point
 * about the connector moves onto the first leg. Each leg's meaning is inferred from what it now
 * joins, through Junctions too. Returns the document unchanged when the splice isn't possible
 * (`canSpliceInto`), and the ids of both legs otherwise.
 */
export function spliceNodeIntoEdge(
  doc: DraftDocument,
  edgeId: string,
  nodeId: string,
): { doc: DraftDocument; legs: [string, string] | null } {
  if (!canSpliceInto(doc, edgeId, nodeId)) return { doc, legs: null };
  const edge = doc.edges.find((e) => e.id === edgeId)!;
  const into = { ...createEdge({ source: edge.source, target: nodeId, directed: edge.directed, routing: edge.routing }), ...carried(edge) };
  const out = createEdge({ source: nodeId, target: edge.target, directed: edge.directed, routing: edge.routing });
  // Replacements are added and spliced into flow steps *before* the original goes, so a flow keeps
  // its beat instead of `removeElements` pruning it.
  let next = addEdges(doc, [into, out]);
  next = spliceEdgeInFlows(next, edgeId, [into.id, out.id]);
  next = retargetOpenPoints(next, { kind: 'edge', id: edgeId }, { kind: 'edge', id: into.id });
  next = removeElements(next, [], [edgeId]);
  // Inferred once the old connector is gone, so a Junction resolves through the legs, not it.
  next = reinferIfEligible(next, into.id);
  next = reinferIfEligible(next, out.id);
  return { doc: next, legs: [into.id, out.id] };
}

/** Why a shape can't be taken out with its lines joined: nothing to join, or no single way to. */
export type BridgeProblem = 'many-to-many';

interface Bridge {
  incoming: DraftEdge;
  outgoing: DraftEdge;
}

/** The connectors a shape has on each side, ignoring a loop on itself. */
function sidesOf(doc: DraftDocument, nodeId: string) {
  const incoming = doc.edges.filter((e) => e.target === nodeId && e.source !== nodeId);
  const outgoing = doc.edges.filter((e) => e.source === nodeId && e.target !== nodeId);
  return { incoming, outgoing };
}

/**
 * Which of `nodeIds` can't be removed with their lines joined: those with several ways in *and*
 * several ways out. Joining every one to every other would invent connections nobody drew.
 */
export function bridgeProblems(doc: DraftDocument, nodeIds: readonly string[]): string[] {
  return nodeIds.filter((id) => {
    const { incoming, outgoing } = sidesOf(doc, id);
    return incoming.length > 1 && outgoing.length > 1;
  });
}

/**
 * Removes `nodeIds` and joins the lines through each one back up: `A → G → B` leaves `A → B`.
 * A shape with one way in and several out (or the reverse) is joined to each of them. Removed one
 * at a time, so a chain of selected shapes (`A → G1 → G2 → B`) joins all the way through. The new
 * connector keeps the incoming leg's label (or the outgoing one's, when only that had one), both
 * legs' attachments, flow steps and open points, and has its meaning inferred from what it now
 * joins. A pair that is already connected isn't connected twice. Everything else about removal is
 * `removeElements`'s, so a boundary's contents and the shapes' own open points go as with Delete.
 * Returns `null` when a shape can't be joined unambiguously (`bridgeProblems`).
 */
export function removeAndBridge(
  doc: DraftDocument,
  nodeIds: readonly string[],
): { doc: DraftDocument; joined: number } | null {
  if (bridgeProblems(doc, nodeIds).length > 0) return null;
  let next = doc;
  let joined = 0;
  const merged: string[] = [];
  for (const nodeId of nodeIds) {
    if (!next.nodes.some((n) => n.id === nodeId)) continue;
    const { incoming, outgoing } = sidesOf(next, nodeId);
    // Joining an earlier shape of the selection can give a later one several ways in as well as
    // out; that one is just as ambiguous as if it had been drawn so.
    if (incoming.length > 1 && outgoing.length > 1) return null;
    const bridges: Bridge[] = incoming.flatMap((inEdge) => outgoing.map((outEdge) => ({ incoming: inEdge, outgoing: outEdge })));
    for (const { incoming: inEdge, outgoing: outEdge } of bridges) {
      if (inEdge.source === outEdge.target) continue;
      const exists = next.edges.some((e) => e.source === inEdge.source && e.target === outEdge.target);
      if (exists) continue;
      const label = inEdge.label ?? outEdge.label;
      const attachments = [...(inEdge.attachments ?? []), ...(outEdge.attachments ?? [])];
      const edge: DraftEdge = {
        ...createEdge({
          source: inEdge.source,
          target: outEdge.target,
          directed: inEdge.directed || outEdge.directed,
          routing: inEdge.routing,
          label,
          condition: inEdge.condition ?? outEdge.condition,
          accent: inEdge.accent ?? outEdge.accent,
        }),
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(inEdge.details ?? outEdge.details ? { details: inEdge.details ?? outEdge.details } : {}),
      };
      next = addEdges(next, [edge]);
      next = mergeEdgesInFlows(next, inEdge.id, outEdge.id, edge.id);
      next = retargetOpenPoints(next, { kind: 'edge', id: inEdge.id }, { kind: 'edge', id: edge.id });
      next = retargetOpenPoints(next, { kind: 'edge', id: outEdge.id }, { kind: 'edge', id: edge.id });
      merged.push(edge.id);
      joined += 1;
    }
    next = removeElements(next, [nodeId], []);
  }
  // Inferred last, against the finished graph: a joined connector may run through a Junction
  // whose other side was only joined up later in the loop.
  for (const id of merged) next = reinferIfEligible(next, id);
  return { doc: next, joined };
}
