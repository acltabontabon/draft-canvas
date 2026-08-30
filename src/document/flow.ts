/**
 * Flows: named, ordered walkthroughs of existing connectors.
 *
 * Generalizes the old single-track "sequence" concept (one document-wide
 * numbered walkthrough, kept as `DraftEdge.sequence`) into any number of
 * named, independent walkthroughs that can share or diverge on the same
 * connectors. Order comes from a step's position within a flow's `steps`
 * array, never a field on the edge — that is what lets one connector belong
 * to several flows, at different positions, at the same time.
 *
 * A flow does not duplicate node or edge data; a step only ever references an
 * edge id. Presentation Mode reads exactly this list.
 */
import { createId } from './ids';
import { LIMITS } from './limits';
import type { DraftDocument, DraftEdge, DraftFlow, DraftFlowStep } from './types';

export interface CreateFlowInput {
  title?: string;
  id?: string;
}

export function createFlow(input: CreateFlowInput = {}): DraftFlow {
  return {
    id: input.id ?? createId('f'),
    title: (input.title?.trim() || 'Untitled flow').slice(0, LIMITS.maxFlowTitleLength),
    steps: [],
  };
}

export function findFlow(doc: DraftDocument, flowId: string): DraftFlow | undefined {
  return doc.flows.find((flow) => flow.id === flowId);
}

/** 1-based position of an edge within a flow's steps, or `undefined` if it isn't one. */
export function stepIndexOf(flow: DraftFlow | undefined, edgeId: string): number | undefined {
  if (!flow) return undefined;
  const index = flow.steps.findIndex((step) => step.edgeId === edgeId);
  return index === -1 ? undefined : index + 1;
}

/**
 * Presentation Mode's three visual tiers: the step being explained right
 * now, a step already covered (kept visible but subdued, so the audience can
 * see how the path got here), or one not reached yet (dimmed the same as
 * anything outside the flow entirely).
 */
export type ExplainTier = 'active' | 'shown' | 'hidden';

/** A position outside the flow (or no flow selected at all) is always `hidden`. */
export function explainEdgeTier(position: number | undefined, step: number): ExplainTier {
  if (typeof position !== 'number') return 'hidden';
  if (position === step) return 'active';
  return position < step ? 'shown' : 'hidden';
}

/** A node's tier is the most-lit tier among the flow's edges touching it — a node on
 *  both an already-shown step and an untouched one still reads as `shown`. */
export function explainNodeTier(
  flow: DraftFlow | undefined,
  edges: Iterable<DraftEdge>,
  nodeId: string,
  step: number,
): ExplainTier {
  if (!flow) return 'hidden';
  let best: ExplainTier = 'hidden';
  for (const edge of edges) {
    if (edge.source !== nodeId && edge.target !== nodeId) continue;
    const tier = explainEdgeTier(stepIndexOf(flow, edge.id), step);
    if (tier === 'active') return 'active';
    if (tier === 'shown') best = 'shown';
  }
  return best;
}

function withFlows(doc: DraftDocument, flows: DraftFlow[]): DraftDocument {
  return flows === doc.flows ? doc : { ...doc, flows };
}

export function addFlow(doc: DraftDocument, flow: DraftFlow): DraftDocument {
  if (doc.flows.length >= LIMITS.maxFlows) return doc;
  return withFlows(doc, [...doc.flows, flow]);
}

export function renameFlow(doc: DraftDocument, flowId: string, title: string): DraftDocument {
  const trimmed = title.trim().slice(0, LIMITS.maxFlowTitleLength) || 'Untitled flow';
  let changed = false;
  const flows = doc.flows.map((flow) => {
    if (flow.id !== flowId || flow.title === trimmed) return flow;
    changed = true;
    return { ...flow, title: trimmed };
  });
  return changed ? withFlows(doc, flows) : doc;
}

export function deleteFlow(doc: DraftDocument, flowId: string): DraftDocument {
  const flows = doc.flows.filter((flow) => flow.id !== flowId);
  return flows.length === doc.flows.length ? doc : withFlows(doc, flows);
}

/** Appends an existing connector to the end of a flow. No-op if it's already a step of that flow. */
export function addStepToFlow(
  doc: DraftDocument,
  flowId: string,
  edgeId: string,
  caption?: string,
): DraftDocument {
  const flow = findFlow(doc, flowId);
  if (!flow || !doc.edges.some((e) => e.id === edgeId)) return doc;
  if (stepIndexOf(flow, edgeId) !== undefined) return doc;
  if (flow.steps.length >= LIMITS.maxStepsPerFlow) return doc;

  const step: DraftFlowStep = { id: createId('fs'), edgeId };
  if (caption?.trim()) step.caption = caption.trim().slice(0, LIMITS.maxLabelLength);

  return withFlows(
    doc,
    doc.flows.map((f) => (f.id === flowId ? { ...f, steps: [...f.steps, step] } : f)),
  );
}

export function removeStepFromFlow(doc: DraftDocument, flowId: string, stepId: string): DraftDocument {
  const flow = findFlow(doc, flowId);
  if (!flow) return doc;
  const steps = flow.steps.filter((s) => s.id !== stepId);
  if (steps.length === flow.steps.length) return doc;
  return withFlows(doc, doc.flows.map((f) => (f.id === flowId ? { ...f, steps } : f)));
}

/** Moves a step one position earlier or later, swapping with its neighbor. */
export function moveStepInFlow(
  doc: DraftDocument,
  flowId: string,
  stepId: string,
  direction: -1 | 1,
): DraftDocument {
  const flow = findFlow(doc, flowId);
  if (!flow) return doc;
  const from = flow.steps.findIndex((s) => s.id === stepId);
  const to = from + direction;
  if (from === -1 || to < 0 || to >= flow.steps.length) return doc;

  const steps = [...flow.steps];
  [steps[from], steps[to]] = [steps[to]!, steps[from]!];
  return withFlows(doc, doc.flows.map((f) => (f.id === flowId ? { ...f, steps } : f)));
}

export function updateFlowStepCaption(
  doc: DraftDocument,
  flowId: string,
  stepId: string,
  caption: string,
): DraftDocument {
  const flow = findFlow(doc, flowId);
  if (!flow) return doc;
  const trimmed = caption.trim().slice(0, LIMITS.maxLabelLength);
  let changed = false;
  const steps = flow.steps.map((step) => {
    if (step.id !== stepId) return step;
    if ((step.caption ?? '') === trimmed) return step;
    changed = true;
    if (!trimmed) {
      const { caption: _drop, ...rest } = step;
      return rest;
    }
    return { ...step, caption: trimmed };
  });
  return changed ? withFlows(doc, doc.flows.map((f) => (f.id === flowId ? { ...f, steps } : f))) : doc;
}

/** Strips any flow step referencing one of the given edge ids — used when a connector is deleted. */
export function pruneFlowSteps(doc: DraftDocument, removedEdgeIds: ReadonlySet<string>): DraftDocument {
  if (removedEdgeIds.size === 0 || doc.flows.length === 0) return doc;
  let changed = false;
  const flows = doc.flows.map((flow) => {
    const steps = flow.steps.filter((step) => !removedEdgeIds.has(step.edgeId));
    if (steps.length === flow.steps.length) return flow;
    changed = true;
    return { ...flow, steps };
  });
  return changed ? withFlows(doc, flows) : doc;
}
