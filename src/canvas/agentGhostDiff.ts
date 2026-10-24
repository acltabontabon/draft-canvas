/**
 * What changed between one view of the document and a proposed after-view, split into the buckets
 * an on-canvas ghost renders differently: additions, geometric/label modifications, and removals,
 * each for plain nodes, groups (boundaries) and edges. Shared by `AgentPreviewLayer.tsx` for both
 * the live-write preview and the proposal-review preview, so the two never drift on what counts as
 * "changed" or which shapes get a removal treatment.
 *
 * Deliberately narrower than `agent/proposal.ts`'s `diffForReview`: this only decides what a ghost
 * draws (geometry, wiring, a few display fields), not the full field-by-field before/after text a
 * reviewer reads — that stays the review panel's job.
 */

import type { DraftEdge, DraftNode } from '../document/types';

export interface AgentGhostView {
  nodes: readonly DraftNode[];
  edges: readonly DraftEdge[];
}

export interface AgentGhostDiff {
  addedNodes: DraftNode[];
  modifiedNodes: DraftNode[];
  removedNodes: DraftNode[];
  addedGroups: DraftNode[];
  modifiedGroups: DraftNode[];
  removedGroups: DraftNode[];
  addedEdges: DraftEdge[];
  modifiedEdges: DraftEdge[];
  removedEdges: DraftEdge[];
}

function nodeChanged(before: DraftNode, after: DraftNode): boolean {
  if (before === after) return false;
  return (
    before.x !== after.x ||
    before.y !== after.y ||
    before.width !== after.width ||
    before.height !== after.height ||
    before.text !== after.text ||
    before.type !== after.type ||
    // Matches `nodeFields` in `agent/proposal.ts`'s field-by-field text diff (label/type/description/
    // technology/group), plus geometry the text diff doesn't need but a ghost does — otherwise a
    // reparent, or a C4 description/technology edit (both drawn on the shape itself), shows as
    // "modified" in the text list but nowhere on the canvas ghost.
    before.description !== after.description ||
    before.technology !== after.technology ||
    before.parentId !== after.parentId ||
    before.accent !== after.accent ||
    before.serviceKind !== after.serviceKind ||
    before.databaseKind !== after.databaseKind ||
    before.queueKind !== after.queueKind ||
    before.actorKind !== after.actorKind ||
    before.actorFrame !== after.actorFrame ||
    before.componentKind !== after.componentKind ||
    before.noteKind !== after.noteKind ||
    before.boundaryPreset !== after.boundaryPreset ||
    before.code !== after.code ||
    before.language !== after.language ||
    JSON.stringify(before.attachments) !== JSON.stringify(after.attachments) ||
    JSON.stringify(before.evidence) !== JSON.stringify(after.evidence)
  );
}

function anchorsOf(edge: DraftEdge): string {
  return JSON.stringify([edge.sourceAnchor, edge.targetAnchor]);
}

function edgeChanged(before: DraftEdge, after: DraftEdge): boolean {
  if (before === after) return false;
  return (
    before.source !== after.source ||
    before.target !== after.target ||
    before.label !== after.label ||
    before.semantic !== after.semantic ||
    before.kind !== after.kind ||
    before.condition !== after.condition ||
    anchorsOf(before) !== anchorsOf(after) ||
    before.directed !== after.directed ||
    before.async !== after.async ||
    before.routing !== after.routing ||
    before.routeMode !== after.routeMode ||
    JSON.stringify(before.waypoints) !== JSON.stringify(after.waypoints) ||
    before.accent !== after.accent ||
    before.hasResponse !== after.hasResponse ||
    before.response !== after.response ||
    before.deliveryAttempts !== after.deliveryAttempts ||
    JSON.stringify(before.attachments) !== JSON.stringify(after.attachments) ||
    JSON.stringify(before.evidence) !== JSON.stringify(after.evidence)
  );
}

export function agentGhostDiff(before: AgentGhostView, after: AgentGhostView): AgentGhostDiff {
  const beforeNodes = new Map(before.nodes.map((n) => [n.id, n]));
  const afterNodes = new Map(after.nodes.map((n) => [n.id, n]));

  const addedNodes: DraftNode[] = [];
  const modifiedNodes: DraftNode[] = [];
  const addedGroups: DraftNode[] = [];
  const modifiedGroups: DraftNode[] = [];
  for (const [id, node] of afterNodes) {
    const was = beforeNodes.get(id);
    const added = node.type === 'group' ? addedGroups : addedNodes;
    const modified = node.type === 'group' ? modifiedGroups : modifiedNodes;
    if (!was) added.push(node);
    else if (nodeChanged(was, node)) modified.push(node);
  }

  const removedNodes: DraftNode[] = [];
  const removedGroups: DraftNode[] = [];
  for (const [id, was] of beforeNodes) {
    if (afterNodes.has(id)) continue;
    (was.type === 'group' ? removedGroups : removedNodes).push(was);
  }

  const beforeEdges = new Map(before.edges.map((e) => [e.id, e]));
  const afterEdges = new Map(after.edges.map((e) => [e.id, e]));

  const addedEdges: DraftEdge[] = [];
  const modifiedEdges: DraftEdge[] = [];
  for (const [id, edge] of afterEdges) {
    const was = beforeEdges.get(id);
    if (!was) addedEdges.push(edge);
    else if (edgeChanged(was, edge)) modifiedEdges.push(edge);
  }

  const removedEdges: DraftEdge[] = [];
  for (const [id, was] of beforeEdges) {
    if (!afterEdges.has(id)) removedEdges.push(was);
  }

  return { addedNodes, modifiedNodes, removedNodes, addedGroups, modifiedGroups, removedGroups, addedEdges, modifiedEdges, removedEdges };
}

/** A shape a change moves or resizes: where it ends up, and where it stands now. */
export interface MovedShape {
  node: DraftNode;
  from: DraftNode;
}

/**
 * The shapes a change moves or resizes (a tidy-up, a regrouping). With any of these, the change is
 * shown as the whole diagram it leads to, laid over the current one, rather than as pieces drawn on
 * top of it: a moved shape drawn over its old self is in two places at once.
 */
export function movedShapes(before: AgentGhostView, after: AgentGhostView): MovedShape[] {
  const was = new Map(before.nodes.map((n) => [n.id, n]));
  const moved: MovedShape[] = [];
  for (const node of after.nodes) {
    const from = was.get(node.id);
    // Only a shape that changes place: a boundary growing to fit a new member, or a box growing with
    // its label, is still where it was, and treating it as a move put a plain addition on the sheet.
    if (from && node.type !== 'group' && (from.x !== node.x || from.y !== node.y)) moved.push({ node, from });
  }
  return moved;
}

const PLACE_KEYS = ['x', 'y', 'width', 'height', 'z', 'sourceAnchor', 'targetAnchor', 'routeMode', 'waypoints'];

/** Whether a shape or connector changed in more than where it sits or how it is routed: what a
 *  re-layout does to everything, and no reason on its own to ink it as changed. */
export function changedBeyondPlace<T extends object>(before: T, after: T): boolean {
  const strip = (item: T) => JSON.stringify(Object.fromEntries(Object.entries(item).filter(([key]) => !PLACE_KEYS.includes(key))));
  return strip(before) !== strip(after);
}
