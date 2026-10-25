/**
 * Removes references that concurrent edits left dangling — and nothing else.
 *
 * One person deletes a shape while another draws a connector to it; one deletes a connector a flow
 * step walks while another adds the step. Each edit was valid against the file its author saw, and
 * applying both leaves a reference to something gone. The editor's own operations cascade these as
 * they delete (`removeElements`); collaboration can't, because the cascade has to see the other
 * person's edit, which arrives later.
 *
 * Prune-only and deterministic: it removes or clears, in file order, and never creates an id, a
 * timestamp or a default. A file that is already consistent comes back as the same object, so this
 * can run after every application without costing re-renders. The rules are `validate.ts`'s, so a
 * repaired file opens without a repair report.
 */
import { mapRooms, type Graph } from '../depth/tree';
import { pruneFlowSteps } from '../document/flow';
import { pruneOpenPoints } from '../document/openPoints';
import { repairCompensationLinks } from '../document/compensation';
import type { DraftDocument, DraftEdge, DraftFlow, DraftNode } from '../document/types';
import { withinGroupDepth } from '../document/validate';
import { indexOf } from './fileIndex';

export function repairReferences(file: DraftDocument): DraftDocument {
  const repaired = mapRooms(file, repairGraph);
  return repairOpenPoints(repaired);
}

function repairGraph<G extends Graph>(graph: G): G {
  const nodes = repairParents(graph.nodes);
  const nodeIds = new Set(nodes.map((node) => node.id));

  let edges: DraftEdge[] = graph.edges;
  if (graph.edges.some((edge) => !nodeIds.has(edge.source) || !nodeIds.has(edge.target) || edge.source === edge.target)) {
    edges = graph.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target) && edge.source !== edge.target);
  }
  edges = repairCompensationLinks(edges);

  const flows = repairFlows(graph.flows, nodeIds, new Set(edges.map((edge) => edge.id)));
  if (nodes === graph.nodes && edges === graph.edges && flows === graph.flows) return graph;
  return { ...graph, nodes, edges, flows };
}

/** Clears membership in a boundary that is gone, is not a boundary, or would make a cycle. */
function repairParents(nodes: DraftNode[]): DraftNode[] {
  if (!nodes.some((node) => node.parentId !== undefined)) return nodes;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  let out: DraftNode[] | undefined;
  nodes.forEach((node, i) => {
    if (node.parentId === undefined) return;
    if (parentIsValid(node, byId)) return;
    const { parentId: _dropped, ...rest } = node;
    out ??= nodes.slice();
    out[i] = rest;
    // Later nodes walk chains through this one, so they must see it cleared.
    byId.set(node.id, rest);
  });
  return out ?? nodes;
}

function parentIsValid(node: DraftNode, byId: Map<string, DraftNode>): boolean {
  const parent = byId.get(node.parentId!);
  if (!parent || parent.id === node.id || parent.type !== 'group') return false;
  // Bounded, as validation is: a chain past the limit, or a loop, goes — and checking costs at most
  // the limit per shape, however long a chain a collaborator built.
  return withinGroupDepth(node, byId);
}

function repairFlows(flows: DraftFlow[], nodeIds: ReadonlySet<string>, edgeIds: ReadonlySet<string>): DraftFlow[] {
  if (flows.length === 0) return flows;
  const missingEdges = new Set<string>();
  const missingNodes = new Set<string>();
  for (const flow of flows) {
    for (const step of flow.steps) {
      if (step.edgeId !== undefined && !edgeIds.has(step.edgeId)) missingEdges.add(step.edgeId);
      for (const id of step.extraEdgeIds ?? []) if (!edgeIds.has(id)) missingEdges.add(id);
      for (const id of step.extraNodeIds ?? []) if (!nodeIds.has(id)) missingNodes.add(id);
    }
  }
  let out = flows;
  if (missingEdges.size > 0 || missingNodes.size > 0) {
    // `pruneFlowSteps` reads and writes only `flows`; a graph is all of a document it needs.
    out = pruneFlowSteps({ flows } as DraftDocument, missingEdges, missingNodes).flows;
  }
  return repairVariants(out);
}

/**
 * `variantOf` is hub-and-spoke (`setFlowVariantOf`): it must name another flow in the room that is
 * not itself a variant, and a flow others name may not be a variant. Checked in list order, so the
 * same file always keeps the same links.
 */
function repairVariants(flows: DraftFlow[]): DraftFlow[] {
  if (!flows.some((flow) => flow.variantOf !== undefined)) return flows;
  const current = flows.slice();
  let changed = false;
  current.forEach((flow, i) => {
    if (flow.variantOf === undefined) return;
    const target = current.find((other) => other.id === flow.variantOf);
    const hasVariants = current.some((other) => other.variantOf === flow.id);
    if (target && target !== flow && target.variantOf === undefined && !hasVariants) return;
    const { variantOf: _dropped, ...rest } = flow;
    current[i] = rest;
    changed = true;
  });
  return changed ? current : flows;
}

function repairOpenPoints(file: DraftDocument): DraftDocument {
  if (file.openPoints.length === 0) return file;
  const index = indexOf(file);
  const missingNodes = new Set<string>();
  const missingEdges = new Set<string>();
  for (const point of file.openPoints) {
    for (const target of point.targets) {
      if (target.kind === 'node' ? !index.nodes.has(target.id) : !index.edges.has(target.id)) {
        (target.kind === 'node' ? missingNodes : missingEdges).add(target.id);
      }
    }
  }
  return pruneOpenPoints(file, missingNodes, missingEdges);
}
