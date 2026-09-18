import { useReactFlow, useStore } from '@xyflow/react';
import { fileOf, flowFitViewNodes, useEditorStore, viewLevel } from '../../store/editorStore';
import { isEmpty, openCount, takeawaysFor } from '../../takeaways/collect';
import { count } from '../../lib/plural';
import { LEVEL_HINTS, LEVEL_LABELS } from '../../depth/level';
import { Button } from '../common/Button';
import { Icon } from '../common/Icon';
import { motionMs } from '../../lib/motion';
import { embeddedHost } from '../../host/embeddedHost';
import { useUiStore } from '../../store/uiStore';

/**
 * The save indicator is the only place the local-first promise is visible while
 * working, so it says where the data went, not just that something happened.
 *
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

interface StatusBarProps {
  durable: boolean;
  /** While presenting, only a conflict (if any) is shown — the rest of the bar stays hidden. */
  presenting?: boolean;
  /** See `DocumentSession.resolveConflict`. */
  onResolveConflict?: (choice: 'keep' | 'discard') => void;
}

function ConflictChoice({ conflict, onResolveConflict }: { conflict: 'changed' | 'deleted'; onResolveConflict: (choice: 'keep' | 'discard') => void }) {
  return (
    // Saving waits here until one copy is chosen, so the choice stays on screen, not in a toast.
    <span className="dc-save-conflict" role="group" aria-label="Choose which copy to keep">
      <Button variant="quiet" onClick={() => onResolveConflict('keep')}>
        {conflict === 'deleted' ? 'Keep this canvas' : 'Keep mine'}
      </Button>
      <Button variant="quiet" onClick={() => onResolveConflict('discard')}>
        {conflict === 'deleted' ? 'Close it' : 'Load the other tab’s'}
      </Button>
    </span>
  );
}

export function StatusBar({ durable, presenting = false, onResolveConflict }: StatusBarProps) {
  const save = useEditorStore((state) => state.save);
  const nodeCount = useEditorStore((state) => state.document.nodes.length);
  const edgeCount = useEditorStore((state) => state.document.edges.length);

  // A cross-tab conflict (another tab changed or deleted this canvas) can arrive while presenting;
  // the rest of the status bar stays out of the way, but the conflict itself must still be
  // resolvable — otherwise it sits invisible until the presenter happens to exit.
  if (presenting) {
    if (!save.conflict || !onResolveConflict) return null;
    return (
      <footer className="dc-status">
        <div className="dc-status-left">
          <ConflictChoice conflict={save.conflict} onResolveConflict={onResolveConflict} />
        </div>
      </footer>
    );
  }

  return (
    <footer className="dc-status">
      {embeddedHost ? (
        // The host saves the file and shows whether it's dirty; this browser's storage isn't involved.
        <div className="dc-status-left">
          <span className="dc-muted dc-status-hint">This diagram is the open file. Nothing you draw is uploaded.</span>
        </div>
      ) : (
        <div className="dc-status-left">
          <span className="dc-save" data-status={save.status}>
            {saveLabel(save, durable)}
          </span>
          {save.conflict && onResolveConflict && <ConflictChoice conflict={save.conflict} onResolveConflict={onResolveConflict} />}
          {/* Announced separately from the label, which cycles Unsaved → Saving… → Saved on every
              commit and would speak three times per drag. Only a failure is news. */}
          <span className="dc-sr-only" role="status">
            {!durable ? 'Storage unavailable. Changes are kept in memory only.' : save.status === 'error' ? saveLabel(save, durable) : ''}
          </span>
          <span className="dc-muted dc-status-hint" hidden={Boolean(save.conflict)}>
            {durable
              ? 'Your diagrams stay in this browser. Nothing you draw is uploaded.'
              : 'This browser is blocking storage — export to keep your work.'}
          </span>
        </div>
      )}

      <div className="dc-status-right">
        <TakeawaysChip />
        <LevelChip />
        <span className="dc-muted">
          {nodeCount} {nodeCount === 1 ? 'element' : 'elements'} · {edgeCount}{' '}
          {edgeCount === 1 ? 'connector' : 'connectors'}
        </span>
        <span className="dc-inspector-divider" />
        <ZoomControls />
      </div>
    </footer>
  );
}

/**
 * What this canvas has to show for the conversation that produced it.
 *
 * The same bargain `LevelChip` strikes below: absent entirely unless there is something to say,
 * which for most canvases is forever — and a label you can act on, because a count you cannot
 * open is the kind of chrome that sends people looking for a setting.
 *
 * It counts decisions and open questions as well as actions, which are notes already on the
 * canvas (`noteKind`) rather than anything this feature stores. So a diagram drawn long before
 * Takeaways existed opens with the chip already showing — which is, in practice, how most people
 * will find out it is there at all.
 */
function TakeawaysChip() {
  const revision = useEditorStore((state) => state.revision);
  const takeaways = (() => {
    void revision;
    return takeawaysFor(fileOf(useEditorStore.getState()));
  })();
  // Bumped when the arrival card settles. Keyed on it rather than toggled by it, so the animation
  // restarts cleanly on a second recall instead of being a class that is already applied.
  const pulse = useUiStore((state) => state.takeawaysChipPulse);
  if (isEmpty(takeaways)) return null;

  const open = openCount(takeaways);
  const label = open > 0 ? count(open, 'open action') : 'takeaways';
  return (
    <>
      <button
        key={pulse}
        type="button"
        className="dc-status-takeaways"
        data-arrived={pulse > 0 || undefined}
        title={open > 0 ? 'Actions still open — review takeaways' : 'What came out of this discussion'}
        aria-label={open > 0 ? `${label}, review takeaways` : 'Review takeaways'}
        onClick={() => useUiStore.getState().setTakeawaysOpen(true)}
      >
        <span className="dc-status-takeaways-glyph" aria-hidden="true">
          {open > 0 ? '\u25a1' : '\u2713'}
        </span>
        {open > 0 ? open : 'takeaways'}
      </button>
      <span className="dc-inspector-divider" />
    </>
  );
}

/**
 * What this view is showing, when anything is known about that — "Containers", "Components".
 *
 * It earns its place by being the answer to a question the suggestions would otherwise raise
 * silently: a known level narrows what Draft Canvas offers here, so it is never narrowed without
 * the reason being on screen. Absent entirely for a canvas nobody has said anything about, which
 * is most of them.
 */
function LevelChip() {
  const level = useEditorStore((state) => viewLevel(state));
  if (!level || level === 'none') return null;
  return (
    <>
      {/* The thing that says what this view shows is also the way to say something else — a label
          you cannot act on is the kind of chrome that makes people go looking for a setting. */}
      <button
        type="button"
        className="dc-status-level"
        title={`${LEVEL_HINTS[level]} — change what this view shows`}
        onClick={() => useUiStore.getState().openCommandPaletteAt('View level')}
      >
        {LEVEL_LABELS[level]}
      </button>
      <span className="dc-inspector-divider" />
    </>
  );
}

/**
 * Its own component, subscribed to the rounded percentage only: the zoom changes on every frame of a
 * wheel zoom or camera move, and the rest of the status bar — hidden entirely while presenting —
 * shouldn't re-render with it.
 */
function ZoomControls() {
  const percent = useStore((state) => Math.round(state.transform[2] * 100));
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  return (
    <>
      <Button variant="quiet" onClick={() => void zoomOut()} aria-label="Zoom out">
        −
      </Button>
      <button
        type="button"
        className="dc-zoom-value"
        aria-label={`${percent}%, fit to view`}
        onClick={() => void fitView({ padding: 0.2, duration: motionMs(300), nodes: flowFitViewNodes(useEditorStore.getState()) })}
        title="Fit to view"
      >
        {percent}%
      </button>
      <Button variant="quiet" onClick={() => void zoomIn()} aria-label="Zoom in">
        +
      </Button>
    </>
  );
}
