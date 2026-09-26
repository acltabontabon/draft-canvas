/**
 * What the current step means for each shape — who it leaves from, who it arrives at, which
 * boundary it crosses — derived once per (document, playback) pair and shared by every node's
 * selector. A node asks "am I the destination?" on every store update; answering that by resolving
 * the step per node would be (nodes × updates) resolutions, so the answer is memoised on the two
 * objects it depends on and each node does a set lookup.
 */
import { findFlow } from '../document/flow';
import type { DraftDocument } from '../document/types';
import type { FlowPlaybackState } from '../store/editorStore';
import { edgeIndex, nodeIndex } from '../store/selectors';
import { crossedBoundaries } from './composition';
import { resolveFlowStep } from './useFlowPlayback';

export interface StepContext {
  /** Changes exactly when a new transition should play: another step, stage, flow or reply phase. */
  transitionKey: string;
  sources: ReadonlySet<string>;
  targets: ReadonlySet<string>;
  /** Boundaries the step's connectors cross. */
  crossed: ReadonlySet<string>;
}

const NONE: ReadonlySet<string> = new Set();

const cache = new WeakMap<FlowPlaybackState, WeakMap<DraftDocument, StepContext | null>>();

/** The current step's context, or `null` when no step is being shown (no playback, an overview). */
export function stepContextOf(state: { document: DraftDocument; flowPlayback: FlowPlaybackState }): StepContext | null {
  const { flowPlayback, document } = state;
  let byDocument = cache.get(flowPlayback);
  if (!byDocument) cache.set(flowPlayback, (byDocument = new WeakMap()));
  const known = byDocument.get(document);
  if (known !== undefined) return known;
  const context = compute(document, flowPlayback);
  byDocument.set(document, context);
  return context;
}

function compute(document: DraftDocument, playback: FlowPlaybackState): StepContext | null {
  if (!playback.active || !playback.flowId || playback.stage || playback.step < 1) return null;
  const flow = findFlow(document, playback.flowId);
  if (!flow) return null;
  const edgesById = edgeIndex(document.edges);
  const nodesById = nodeIndex(document.nodes);
  // The same numbering `resolveFlowSteps` gives: dangling steps drop out and the rest count up.
  let position = 0;
  for (const entry of flow.steps) {
    const resolved = resolveFlowStep(entry, 0, position + 1, edgesById, nodesById);
    if (!resolved) continue;
    position += 1;
    if (position !== playback.step) continue;
    const sources = new Set<string>();
    const targets = new Set<string>();
    const crossed = new Set<string>();
    for (const edge of resolved.edges) {
      sources.add(edge.source);
      targets.add(edge.target);
      for (const boundary of crossedBoundaries(nodesById, edge.source, edge.target)) crossed.add(boundary.id);
    }
    return {
      transitionKey: `${playback.flowId}:${playback.step}:${playback.phase ?? 'request'}`,
      sources,
      targets: targets.size > 0 ? targets : NONE,
      crossed: crossed.size > 0 ? crossed : NONE,
    };
  }
  return null;
}
