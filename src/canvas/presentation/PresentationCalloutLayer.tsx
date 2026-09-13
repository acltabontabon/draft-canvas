import { useMemo } from 'react';
import { findFlow } from '../../document/flow';
import type { DraftEdge, DraftNode } from '../../document/types';
import {
  describePresentationSubject,
  presentationScope,
  resolvePresentationSubject,
  revealIn,
  revealedSubject,
} from '../../presentation/presentationAttachments';
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
  // Picked apart rather than the whole object: playback's `phase` timer would otherwise re-render
  // (and re-place) every callout mid-step for nothing.
  const active = useEditorStore((state) => state.flowPlayback.active);
  const flowId = useEditorStore((state) => state.flowPlayback.flowId);
  const step = useEditorStore((state) => state.flowPlayback.step);
  const presenting = useEditorStore((state) => state.mode === 'present');
  const flow = useEditorStore((state) =>
    active && flowId ? (findFlow(state.document, flowId) ?? null) : null,
  );
  // A presenter's click only means something while presenting, and only for the moment it was
  // made in — a reveal from the previous step is ignored even on the render before it's cleared.
  const scope = presentationScope({ active, flowId, step });
  const reveal = useUiStore((state) => (presenting ? revealIn(state.presentationReveal, scope) : null));
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
    return resolvePresentationSubject({ flowId: flow.id, steps, step, nodesById, edgesById, reveal });
  }, [flow, steps, step, nodes, edges, reveal]);

  const { current, leaving, settle } = useCalloutPresence(subject);
  const shown = [leaving, current].filter((entry) => entry !== null);

  return (
    <>
      {shown.map((entry) => (
        <PresentationCallout key={entry.key} subject={entry} leaving={entry === leaving} onSettled={settle} />
      ))}
      {/* With a flow playing, the flow bar's own announcement already carries the callout. With
          none, a presenter's reveal is the only thing that changed — say it here. */}
      {presenting && !flow && (
        <span className="dc-sr-only" role="status">
          {current ? describePresentationSubject(current) : ''}
        </span>
      )}
    </>
  );
}
