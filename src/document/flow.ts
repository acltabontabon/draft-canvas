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
import type { Accent, DraftDocument, DraftEdge, DraftFlow, DraftFlowStep, DraftViewport } from './types';

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

/**
 * 1-based position of an edge within a flow's steps, or `undefined` if it
 * isn't referenced by any — whether as a step's primary connector or one of
 * its `extraEdgeIds`. Every edge a step highlights gets the same step
 * number and the same explain tier; there is no primary/secondary
 * distinction once a step is active.
 */
export function stepIndexOf(flow: DraftFlow | undefined, edgeId: string): number | undefined {
  if (!flow) return undefined;
  const index = flow.steps.findIndex(
    (step) => step.edgeId === edgeId || step.extraEdgeIds?.includes(edgeId),
  );
  return index === -1 ? undefined : index + 1;
}

/** Every 1-based position where a node appears in a flow's steps via
 *  `extraNodeIds` — plural, unlike `stepIndexOf`, because a node reasonably
 *  recurs across several "frame" steps (e.g. a client present in most of a
 *  walkthrough), where a single edge belonging to more than one step of the
 *  same flow is not a case the data model anticipates. */
function frameStepPositions(flow: DraftFlow, nodeId: string): number[] {
  const positions: number[] = [];
  flow.steps.forEach((step, index) => {
    if (step.extraNodeIds?.includes(nodeId)) positions.push(index + 1);
  });
  return positions;
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

/**
 * A node's tier is the most-lit tier among every step that lights it up —
 * either as an endpoint of one of the flow's edges, or by name in a "frame"
 * step's `extraNodeIds`. A node on both an already-shown step and an
 * untouched one still reads as `shown`.
 */
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
  for (const position of frameStepPositions(flow, nodeId)) {
    const tier = explainEdgeTier(position, step);
    if (tier === 'active') return 'active';
    if (tier === 'shown') best = 'shown';
  }
  return best;
}

/**
 * The lens's two tiers: a connector is either part of the currently-inspected
 * flow or it isn't. Deliberately distinct from `ExplainTier`: that type is
 * step-progression-based ("explained yet, explaining now, not yet reached")
 * and only meaningful once a flow is actively being *presented*. Merely
 * *selecting* a flow to inspect it has no "current step" — every member of
 * the flow is equally part of the story, so a binary membership check is the
 * right primitive, not a degenerate case of the three-tier one.
 */
export type LensTier = 'member' | 'dimmed';

/** A connector's lens tier for the given flow — `'dimmed'` if no flow is given. */
export function lensEdgeTier(flow: DraftFlow | undefined, edgeId: string): LensTier {
  if (!flow) return 'dimmed';
  return stepIndexOf(flow, edgeId) !== undefined ? 'member' : 'dimmed';
}

/** A node's lens tier: `'member'` if it touches a member edge, or is spotlit
 *  by a "frame" step's `extraNodeIds`, for the given flow. */
export function lensNodeTier(flow: DraftFlow | undefined, edges: Iterable<DraftEdge>, nodeId: string): LensTier {
  if (!flow) return 'dimmed';
  for (const edge of edges) {
    if (edge.source !== nodeId && edge.target !== nodeId) continue;
    if (lensEdgeTier(flow, edge.id) === 'member') return 'member';
  }
  return frameStepPositions(flow, nodeId).length > 0 ? 'member' : 'dimmed';
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

/** Sets, or clears (`undefined`), a flow's lens accent — see `DraftFlow.accent`. */
export function setFlowAccent(doc: DraftDocument, flowId: string, accent: Accent | undefined): DraftDocument {
  const flow = findFlow(doc, flowId);
  if (!flow || flow.accent === accent) return doc;
  const next = { ...flow };
  if (accent) next.accent = accent;
  else delete next.accent;
  return withFlows(
    doc,
    doc.flows.map((f) => (f.id === flowId ? next : f)),
  );
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

function updateStep(
  doc: DraftDocument,
  flowId: string,
  stepId: string,
  update: (step: DraftFlowStep) => DraftFlowStep,
): DraftDocument {
  const flow = findFlow(doc, flowId);
  if (!flow) return doc;
  let changed = false;
  const steps = flow.steps.map((step) => {
    if (step.id !== stepId) return step;
    const next = update(step);
    if (next === step) return step;
    changed = true;
    return next;
  });
  return changed ? withFlows(doc, doc.flows.map((f) => (f.id === flowId ? { ...f, steps } : f))) : doc;
}

/** Adds a node to a step's `extraNodeIds` — spotlighting it beyond whatever
 *  its primary connector's own endpoints already cover. No-op if the node
 *  doesn't exist, is already a member, or the step is at the cap. */
export function addStepExtraNode(
  doc: DraftDocument,
  flowId: string,
  stepId: string,
  nodeId: string,
): DraftDocument {
  if (!doc.nodes.some((n) => n.id === nodeId)) return doc;
  return updateStep(doc, flowId, stepId, (step) => {
    const extraNodeIds = step.extraNodeIds ?? [];
    if (extraNodeIds.includes(nodeId) || extraNodeIds.length >= LIMITS.maxExtraMembersPerStep) return step;
    return { ...step, extraNodeIds: [...extraNodeIds, nodeId] };
  });
}

export function removeStepExtraNode(
  doc: DraftDocument,
  flowId: string,
  stepId: string,
  nodeId: string,
): DraftDocument {
  return updateStep(doc, flowId, stepId, (step) => {
    if (!step.extraNodeIds?.includes(nodeId)) return step;
    const extraNodeIds = step.extraNodeIds.filter((id) => id !== nodeId);
    const next = { ...step };
    if (extraNodeIds.length > 0) next.extraNodeIds = extraNodeIds;
    else delete next.extraNodeIds;
    return next;
  });
}

/** Adds a connector to a step's `extraEdgeIds`, beyond its primary `edgeId`. */
export function addStepExtraEdge(
  doc: DraftDocument,
  flowId: string,
  stepId: string,
  edgeId: string,
): DraftDocument {
  if (!doc.edges.some((e) => e.id === edgeId)) return doc;
  return updateStep(doc, flowId, stepId, (step) => {
    if (step.edgeId === edgeId) return step;
    const extraEdgeIds = step.extraEdgeIds ?? [];
    if (extraEdgeIds.includes(edgeId) || extraEdgeIds.length >= LIMITS.maxExtraMembersPerStep) return step;
    return { ...step, extraEdgeIds: [...extraEdgeIds, edgeId] };
  });
}

export function removeStepExtraEdge(
  doc: DraftDocument,
  flowId: string,
  stepId: string,
  edgeId: string,
): DraftDocument {
  return updateStep(doc, flowId, stepId, (step) => {
    if (!step.extraEdgeIds?.includes(edgeId)) return step;
    const extraEdgeIds = step.extraEdgeIds.filter((id) => id !== edgeId);
    const next = { ...step };
    if (extraEdgeIds.length > 0) next.extraEdgeIds = extraEdgeIds;
    else delete next.extraEdgeIds;
    return next;
  });
}

/** Sets, or clears (`undefined`), a step's explicit playback viewport. */
export function setStepViewport(
  doc: DraftDocument,
  flowId: string,
  stepId: string,
  viewport: DraftViewport | undefined,
): DraftDocument {
  return updateStep(doc, flowId, stepId, (step) => {
    if (viewport) return { ...step, viewport };
    if (!step.viewport) return step;
    const { viewport: _drop, ...rest } = step;
    return rest;
  });
}

/**
 * Repairs (rather than always dropping) a step referencing a deleted
 * connector or node: a dangling primary `edgeId` is cleared, and dangling
 * ids are filtered out of `extraEdgeIds`/`extraNodeIds` — the step survives
 * if anything is still left for it to show. A step with nothing left at all
 * is the only one actually removed.
 */
export function pruneFlowSteps(
  doc: DraftDocument,
  removedEdgeIds: ReadonlySet<string>,
  removedNodeIds: ReadonlySet<string> = new Set(),
): DraftDocument {
  if ((removedEdgeIds.size === 0 && removedNodeIds.size === 0) || doc.flows.length === 0) return doc;
  let docChanged = false;
  const flows = doc.flows.map((flow) => {
    let flowChanged = false;
    const steps: DraftFlowStep[] = [];
    for (const step of flow.steps) {
      const primaryRemoved = step.edgeId !== undefined && removedEdgeIds.has(step.edgeId);
      const extraEdgeIds = step.extraEdgeIds?.filter((id) => !removedEdgeIds.has(id));
      const extraEdgesTrimmed = (extraEdgeIds?.length ?? 0) !== (step.extraEdgeIds?.length ?? 0);
      const extraNodeIds = step.extraNodeIds?.filter((id) => !removedNodeIds.has(id));
      const extraNodesTrimmed = (extraNodeIds?.length ?? 0) !== (step.extraNodeIds?.length ?? 0);

      if (!primaryRemoved && !extraEdgesTrimmed && !extraNodesTrimmed) {
        steps.push(step);
        continue;
      }
      flowChanged = true;
      const next: DraftFlowStep = { ...step };
      if (primaryRemoved) delete next.edgeId;
      if (extraEdgeIds && extraEdgeIds.length > 0) next.extraEdgeIds = extraEdgeIds;
      else delete next.extraEdgeIds;
      if (extraNodeIds && extraNodeIds.length > 0) next.extraNodeIds = extraNodeIds;
      else delete next.extraNodeIds;

      if (!next.edgeId && !next.extraEdgeIds?.length && !next.extraNodeIds?.length) continue;
      steps.push(next);
    }
    if (!flowChanged) return flow;
    docChanged = true;
    return { ...flow, steps };
  });
  return docChanged ? withFlows(doc, flows) : doc;
}
