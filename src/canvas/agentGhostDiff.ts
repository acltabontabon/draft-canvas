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
    before.parentId !== after.parentId
  );
}

function anchorsOf(edge: DraftEdge): string {
  return JSON.stringify([edge.sourceAnchor, edge.targetAnchor]);
}

function edgeChanged(before: DraftEdge, after: DraftEdge): boolean {
  return (
    before.source !== after.source ||
    before.target !== after.target ||
    before.label !== after.label ||
    before.semantic !== after.semantic ||
    before.kind !== after.kind ||
    before.condition !== after.condition ||
    anchorsOf(before) !== anchorsOf(after)
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
