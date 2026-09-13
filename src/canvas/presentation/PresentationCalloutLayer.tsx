import { useMemo } from 'react';
import { findFlow } from '../../document/flow';
import type { DraftEdge, DraftNode } from '../../document/types';
import { resolvePresentationSubject, revealedSubject } from '../../presentation/presentationAttachments';
import { resolveFlowSteps } from '../../presentation/useFlowPlayback';
import { useEditorStore } from '../../store/editorStore';
import { edgeIndex, nodeIndex } from '../../store/selectors';
import { useUiStore } from '../../store/uiStore';
import { PresentationCallout } from './PresentationCallout';
import { useCalloutPresence } from './useCalloutPresence';

const NO_NODES: DraftNode[] = [];
const NO_EDGES: DraftEdge[] = [];

/**
 * Presentation Mode's callouts: while a flow plays, the step's element tells what it carries.
 *
 *   playback step → who speaks (`resolvePresentationSubject`) → presence (current + one leaving)
 *   → `PresentationCallout`, which anchors and places itself.
 *
 * Everything here is derived from store state — no timers — so stepping quickly converges on the
 * step you land on. Mounted beside the canvas popovers, inside React Flow's provider.
 */
export function PresentationCalloutLayer() {
  const playback = useEditorStore((state) => state.flowPlayback);
  const presenting = useEditorStore((state) => state.mode === 'present');
  const flow = useEditorStore((state) =>
    playback.active && playback.flowId ? (findFlow(state.document, playback.flowId) ?? null) : null,
  );
  // A presenter's click only means something while presenting.
  const reveal = useUiStore((state) => (presenting ? state.presentationReveal : null));
  // Watched only while there's something to tell — editing never re-renders this layer.
  const watching = flow !== null || reveal !== null;
  const nodes = useEditorStore((state) => (watching ? state.document.nodes : NO_NODES));
  const edges = useEditorStore((state) => (watching ? state.document.edges : NO_EDGES));

  const steps = useMemo(() => (flow ? resolveFlowSteps(flow, edges, nodes) : []), [flow, edges, nodes]);
  const subject = useMemo(() => {
    if (!flow && !reveal) return null;
    const nodesById = nodeIndex(nodes);
    const edgesById = edgeIndex(edges);
    // No flow playing: presentation still answers a presenter's click on a chip or badge.
    if (!flow) return reveal ? revealedSubject('present', reveal, nodesById, edgesById) : null;
    return resolvePresentationSubject({ flowId: flow.id, steps, step: playback.step, nodesById, edgesById, reveal });
  }, [flow, steps, playback.step, nodes, edges, reveal]);

  const { current, leaving, settle } = useCalloutPresence(subject);
  const shown = [leaving, current].filter((entry) => entry !== null);

  return (
    <>
      {shown.map((entry) => (
        <PresentationCallout key={entry.key} subject={entry} leaving={entry === leaving} onSettled={settle} />
      ))}
    </>
  );
}
