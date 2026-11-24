import { messageOfStep } from '../document/sequenceFlow';
import type { DraftEdge, DraftFlow, DraftFlowStep, DraftNode, DraftViewport, SeqMessage } from '../document/types';

// What a flow's steps resolve to, apart from the hook that plays them (`useFlowPlayback.ts`): this
// module imports the document model only, so the sequence builder and the export can number steps
// without loading React, React Flow or the editor's stores.

export interface FlowPlaybackStep {
  /** The step's primary connector, when it has one — absent for a "frame" step. */
  edge?: DraftEdge;
  /** Every connector this step highlights: the primary one (if any) followed by `extraEdgeIds`. */
  edges: DraftEdge[];
  /** Nodes this step spotlights beyond its edges' own endpoints. */
  extraNodes: DraftNode[];
  index: number;
  step: number;
  caption?: string;
  /** An explicit viewport this step shows verbatim — `focusOn` skips auto-fit when present. */
  viewport?: DraftViewport;
  /**
   * The message this step is about, when the flow is a sequence telling itself
   * (`document/sequenceFlow.ts`): the step lights that one message inside the sequence, not the
   * sequence as a whole.
   */
  part?: { nodeId: string; message: SeqMessage };
}

/**
 * Resolves one flow step's dangling-safe references into the concrete
 * edges/nodes it lights up. Shared by the `steps` memo and `pickFlow`, which
 * needs to resolve a step before the memo (driven by store state one render
 * behind) has caught up. Exported for unit testing — pure, no React Flow
 * dependency.
 */
export function resolveFlowStep(
  stepEntry: DraftFlowStep,
  index: number,
  step: number,
  edgesById: Map<string, DraftEdge>,
  nodesById: Map<string, DraftNode>,
): FlowPlaybackStep | null {
  const edge = stepEntry.edgeId ? edgesById.get(stepEntry.edgeId) : undefined;
  const extraEdges = (stepEntry.extraEdgeIds ?? [])
    .map((id) => edgesById.get(id))
    .filter((e): e is DraftEdge => Boolean(e));
  const edges = edge ? [edge, ...extraEdges] : extraEdges;
  const extraNodes = (stepEntry.extraNodeIds ?? [])
    .map((id) => nodesById.get(id))
    .filter((n): n is DraftNode => Boolean(n));
  if (edges.length === 0 && extraNodes.length === 0 && !stepEntry.viewport) return null;
  // A sequence's own step is named after its message, and shows nothing but that sequence.
  const host = edges.length === 0 && extraNodes.length === 1 ? extraNodes[0] : undefined;
  const message = messageOfStep(host, stepEntry.id);
  return {
    edge,
    edges,
    extraNodes,
    index,
    step,
    caption: stepEntry.caption,
    viewport: stepEntry.viewport,
    ...(host && message ? { part: { nodeId: host.id, message } } : {}),
  };
}

/**
 * A flow's playable steps, numbered 1..n after dangling steps drop out — what `flowPlayback.step`
 * indexes into. Shared by the hook and Presentation Mode's callout layer, which must agree on it.
 */
export function resolveFlowSteps(
  flow: DraftFlow,
  edges: readonly DraftEdge[],
  nodes: readonly DraftNode[],
): FlowPlaybackStep[] {
  const edgesById = new Map(edges.map((e) => [e.id, e]));
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const result: FlowPlaybackStep[] = [];
  flow.steps.forEach((stepEntry, index) => {
    const resolved = resolveFlowStep(stepEntry, index, result.length + 1, edgesById, nodesById);
    if (resolved) result.push(resolved);
  });
  return result;
}
