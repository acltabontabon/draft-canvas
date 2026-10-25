import { findFlow } from '../document/flow';
import { isCollapsedCompensation, visibleEdges } from '../document/compensation';
import type { DraftDocument, DraftEdge } from '../document/types';
import type { FlowPlaybackState } from '../store/editorStore';
import { resolveFlowSteps } from './useFlowPlayback';

const cache = new WeakMap<DraftDocument, WeakMap<FlowPlaybackState, readonly DraftEdge[]>>();

/** A folded recovery action joins the drawing only while its presentation step is being told. */
export function visibleEdgesForPlayback(document: DraftDocument, playback: FlowPlaybackState): readonly DraftEdge[] {
  let byPlayback = cache.get(document);
  if (!byPlayback) cache.set(document, (byPlayback = new WeakMap()));
  const known = byPlayback.get(playback);
  if (known) return known;

  let result = visibleEdges(document.edges);
  if (playback.active && playback.flowId && !playback.stage && playback.step >= 1) {
    const flow = findFlow(document, playback.flowId);
    const step = flow ? resolveFlowSteps(flow, document.edges, document.nodes)[playback.step - 1] : undefined;
    const hiddenIds = new Set(step?.edges.filter(isCollapsedCompensation).map((edge) => edge.id));
    if (hiddenIds.size > 0) result = document.edges.filter((edge) => !isCollapsedCompensation(edge) || hiddenIds.has(edge.id));
  }

  byPlayback.set(playback, result);
  return result;
}
