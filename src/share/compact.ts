import { walkGraphs } from '../depth/tree';
import type { DraftDocument } from '../document/types';
import type { ShareStart } from './link';

/**
 * A shared snapshot has its own identities. Short deterministic ids avoid carrying the author's
 * random ids repeatedly, while keeping the ordinary document format readable by existing apps.
 * Only structural references change: text, code, evidence, geometry and every room stay intact.
 * `json` is a serialized copy, so this never changes the editor's document.
 */
export function compactShareSnapshot(json: string): { document: DraftDocument; start?: ShareStart } {
  const { document, start } = JSON.parse(json) as { document: DraftDocument; start?: ShareStart };
  const nodes = new Map<string, string>();
  const edges = new Map<string, string>();
  const flows = new Map<string, string>();
  walkGraphs(document, (graph) => {
    for (const node of graph.nodes) nodes.set(node.id, `n_${nodes.size.toString(36)}`);
    for (const edge of graph.edges) edges.set(edge.id, `e_${edges.size.toString(36)}`);
    for (const flow of graph.flows) flows.set(flow.id, `f_${flows.size.toString(36)}`);
  });
  const remap = (ids: Map<string, string>, id: string) => ids.get(id) ?? id;
  let attachment = 0;
  let step = 0;
  walkGraphs(document, (graph) => {
    for (const node of graph.nodes) {
      node.id = remap(nodes, node.id);
      if (node.parentId) node.parentId = remap(nodes, node.parentId);
      for (const entry of node.attachments ?? []) entry.id = `a_${(attachment++).toString(36)}`;
    }
    for (const edge of graph.edges) {
      edge.id = remap(edges, edge.id);
      edge.source = remap(nodes, edge.source);
      edge.target = remap(nodes, edge.target);
      for (const entry of edge.attachments ?? []) entry.id = `a_${(attachment++).toString(36)}`;
    }
    for (const flow of graph.flows) {
      flow.id = remap(flows, flow.id);
      if (flow.variantOf) flow.variantOf = remap(flows, flow.variantOf);
      for (const entry of flow.steps) {
        entry.id = `fs_${(step++).toString(36)}`;
        if (entry.edgeId) entry.edgeId = remap(edges, entry.edgeId);
        if (entry.extraNodeIds) entry.extraNodeIds = entry.extraNodeIds.map((id) => remap(nodes, id));
        if (entry.extraEdgeIds) entry.extraEdgeIds = entry.extraEdgeIds.map((id) => remap(edges, id));
      }
    }
  });
  for (const [index, point] of (document.openPoints ?? []).entries()) {
    point.id = `op_${index.toString(36)}`;
    for (const target of point.targets) target.id = remap(target.kind === 'node' ? nodes : edges, target.id);
  }
  const compactStart = start ? {
    path: start.path.map((id) => remap(nodes, id)),
    ...(start.flowId === undefined ? {} : { flowId: remap(flows, start.flowId) }),
  } : undefined;
  // Arrival already assigns fresh file metadata; the author's local identity and timestamps have
  // no meaning in a recipient's snapshot. No graph or annotation content is omitted.
  document.metadata = { ...document.metadata, id: 'd_share', createdAt: 0, updatedAt: 0 };
  return { document, ...(compactStart ? { start: compactStart } : {}) };
}

export function prepareShareData(json: string, protectedLink: boolean): { bytes: Uint8Array<ArrayBuffer>; start?: ShareStart } {
  const snapshot = compactShareSnapshot(json);
  return {
    bytes: new TextEncoder().encode(JSON.stringify(protectedLink ? snapshot : snapshot.document)),
    start: snapshot.start,
  };
}
