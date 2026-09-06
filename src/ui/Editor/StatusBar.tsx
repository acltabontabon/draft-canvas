import { useReactFlow, useStore } from '@xyflow/react';
import { flowFitViewNodes, useEditorStore } from '../../store/editorStore';
import { Button } from '../common/Button';
import { Icon } from '../common/Icon';

/**
 * The save indicator is the only place the local-first promise is visible while
 * working, so it says where the data went, not just that something happened.
 */
/**
 * Says what is actually true.
 *
 * "Saved locally" while an edit is still queued would be a small lie, and the
 * whole point of the indicator is that the user can stop thinking about saving.
 * Unsaved work is named as such, briefly, until the write lands.
 */
function saveLabel(save: { status: string; message?: string }, durable: boolean) {
  if (!durable) return 'In memory only';
  switch (save.status) {
    case 'saving':
      return 'Saving…';
    case 'error':
      return save.message ?? 'Could not save locally';
    case 'dirty':
      return 'Unsaved changes';
    default:
      return (
        <>
          <Icon name="lock" /> Saved locally
        </>
      );
  }
}

export function StatusBar({ durable }: { durable: boolean }) {
  const save = useEditorStore((state) => state.save);
  const nodeCount = useEditorStore((state) => state.document.nodes.length);
  const edgeCount = useEditorStore((state) => state.document.edges.length);
  const zoom = useStore((state) => state.transform[2]);
  const { zoomIn, zoomOut, fitView } = useReactFlow();

  return (
    <footer className="dc-status">
      <div className="dc-status-left">
<span className="dc-save" data-status={save.status}>{saveLabel(save, durable)}</span>
        <span className="dc-muted dc-status-hint">
          {durable
            ? 'Your diagrams stay in this browser. Nothing you draw is uploaded.'
            : 'This browser is blocking storage — export to keep your work.'}
        </span>
      </div>

      <div className="dc-status-right">
        <span className="dc-muted">
          {nodeCount} {nodeCount === 1 ? 'element' : 'elements'} · {edgeCount}{' '}
          {edgeCount === 1 ? 'connection' : 'connections'}
        </span>
        <span className="dc-inspector-divider" />
        <Button variant="quiet" onClick={() => void zoomOut()} aria-label="Zoom out">
          −
        </Button>
        <button
          type="button"
          className="dc-zoom-value"
          onClick={() => void fitView({ padding: 0.2, duration: 300, nodes: flowFitViewNodes(useEditorStore.getState()) })}
          title="Fit to view"
        >
          {Math.round(zoom * 100)}%
        </button>
        <Button variant="quiet" onClick={() => void zoomIn()} aria-label="Zoom in">
          +
        </Button>
      </div>
    </footer>
  );
}
