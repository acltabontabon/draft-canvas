import { useReactFlow, useStore as useReactFlowStore, type Viewport } from '@xyflow/react';
import { Fragment, useEffect, useMemo, useRef } from 'react';
import { withArrangeMotion } from '../../canvas/arrangeMotion';
import { focusBoundsInView } from '../../commands/search';
import { boundsOf } from '../../document/geometry';
import type { DraftDocument } from '../../document/types';
import { gestureInProgress, useEditorStore } from '../../store/editorStore';
import { useUiStore, type ArrangeDirection, type ArrangePreview, type ArrangeShow } from '../../store/uiStore';
import { Button } from '../common/Button';
import { LayoutNotes } from './LayoutBusyBar';
import { SegmentedControl } from '../common/SegmentedControl';
import { directionNote, fixesNote, layoutNotes, movesNote, readsAs } from './arrangeSummary';

const DIRECTIONS: { value: ArrangeDirection; label: string; name: string }[] = [
  { value: 'right', label: 'Across →', name: 'Across, left to right' },
  { value: 'down', label: 'Down ↓', name: 'Down, top to bottom' },
];

const SHOWS: { value: ArrangeShow; label: string; name: string }[] = [
  { value: 'result', label: 'Result', name: 'Result: the arrangement on its own' },
  { value: 'before', label: 'Before', name: 'Before: the diagram as it is' },
  { value: 'moves', label: 'Moves', name: 'Moves: where every shape goes' },
];

/** How long the camera takes to go back, or on to the applied result: `focusBoundsInView`'s own. */
const CAMERA_MS = 320;

/**
 * Apply or Cancel for an Arrange preview, and the reading direction to arrange in: the room laid out
 * again from scratch is a bigger change than Tidy up's, so it is shown first and chosen, never just
 * done. The canvas shows the result on a tracing sheet (`ArrangePreviewLayer`); the camera frames it,
 * and frames it again when the direction changes, since the two can be very different shapes.
 *
 * The camera is the preview's to move and so the preview's to put back. The view the person had is
 * kept from the moment a preview opens: Cancel returns to it exactly (it used to leave the diagram
 * wherever the preview had framed it, smaller and off centre), **Before** shows it, and Apply frames
 * the diagram that results. What is framed follows what is shown (`ArrangeShow`): the result alone by
 * default, which is the picture being judged, and both layouts only for **Moves**.
 *
 * The suggested direction is picked to begin with: the way the room reads now, unless the other way
 * reads clearly better or fits a screen clearly better (`agent/arrange.ts`). Nothing happens to the
 * diagram until Apply, which is one undo step. Enter applies and Escape cancels from anywhere but a
 * text field or the direction choice itself, and the preview is dropped the moment the room it was
 * worked out from changes — as `TidyBar` does, and always mounted for the same reason.
 */
export function ArrangeBar() {
  const preview = useUiStore((state) => state.arrangePreview);
  const document = useEditorStore((state) => state.document);
  const path = useEditorStore((state) => state.path);
  const editing = useEditorStore((state) => state.mode === 'edit');
  const locked = useUiStore((state) => Boolean(state.readOnly || state.flowTrace));
  const stale = preview !== null && (!editing || locked || document !== preview.base || path !== preview.path);
  const { setViewport, getViewport } = useReactFlow();
  /** The view the person had when the preview opened, kept across a change of direction or a second
   *  Arrange while one is up; forgotten once no preview is. */
  const origin = useRef<Viewport | null>(null);
  const viewWidth = useReactFlowStore((state) => state.width);
  const viewHeight = useReactFlowStore((state) => state.height);
  const shown = preview && !stale ? preview.options[preview.direction] : undefined;
  // What the arrangement shown moves, worked out once per arrangement and not on every render.
  const base = preview?.base;
  const moves = useMemo(() => (shown && base ? movesNote(base, shown) : ''), [shown, base]);

  const show = preview?.show;
  const camera = { viewWidth, viewHeight, setViewport };
  const goBack = () => {
    if (origin.current) void setViewport(origin.current, { duration: CAMERA_MS });
  };
  const cancel = () => {
    goBack();
    useUiStore.getState().setArrangePreview(null);
  };
  const apply = (latest: ArrangePreview) => {
    // A drag or resize in progress holds the diagram: nothing is wrong with the preview, it just
    // cannot go in yet. It stays up (and the camera where it is), rather than being thrown away with
    // a message about the diagram having changed.
    if (gestureInProgress()) {
      useUiStore.getState().notify('Finish what you are dragging first, then apply the arrangement.');
      return;
    }
    const run = (): boolean => {
      const applied = applyArrange(latest);
      if (applied) focusBoundsInView(camera, boundsOf(latest.options[latest.direction]?.nodes ?? []));
      else goBack();
      return applied;
    };
    // Nodi's layout skills play the rearrangement; the document has changed before any of it plays.
    if (latest.motion) void withArrangeMotion(async () => run(), latest.direction);
    else run();
  };

  useEffect(() => {
    if (!stale || !preview) return;
    // The diagram changed under the preview (an undo, a collaborator): the view goes back with it.
    // Not when the person left for another room or mode, where the camera is already theirs again.
    if (editing && path === preview.path) goBack();
    useUiStore.getState().setArrangePreview(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- acts once, when the preview goes stale
  }, [stale]);

  useEffect(() => {
    if (!preview) origin.current = null;
  }, [preview]);

  // What is shown, in view — read once per arrangement and per choice of what to show, not on every
  // resize of the pane.
  useEffect(() => {
    if (!shown || !preview) return;
    origin.current ??= getViewport();
    if (show === 'before') goBack();
    else focusBoundsInView(camera, show === 'moves' ? unionBounds(preview.base, shown) : boundsOf(shown.nodes));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- framed once per arrangement shown, not on every pane resize
  }, [shown, show]);

  useEffect(() => {
    if (!preview) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) {
        // The direction choice is a radio group: Escape still cancels from it, Enter is its own.
        if (!(target instanceof HTMLInputElement && target.type === 'radio' && event.key === 'Escape')) return;
      }
      if (event.key === 'Enter' && !(target instanceof HTMLButtonElement) && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        apply(preview);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `apply` and `cancel` read the pane and the kept view afresh
  }, [preview, viewWidth, viewHeight]);

  if (!preview || stale) return null;
  const choices = DIRECTIONS.filter((d) => preview.options[d.value]);
  const fixed = fixesNote(preview.fixes?.[preview.direction]);
  const notes = layoutNotes(preview, 'arrange');

  return (
    <Fragment>
      <div className="dc-tidy-bar dc-arrange-bar" role="region" aria-label="Arrange preview">
        <span className="dc-tidy-bar-text" role="status">
          <strong>{preview.scoped ? 'Arrange selection' : 'Arrange'}</strong>
          {choices.length < 2 && <span className="dc-tidy-bar-summary">{readsAs(preview.direction)}</span>}
          {moves && <span className="dc-tidy-bar-summary">{moves}</span>}
          {/* Only what this arrangement resolves, marked in teal on the sheet. */}
          {fixed && <span className="dc-tidy-bar-summary dc-arrange-bar-fixes" title={fixed}>{fixed}</span>}
        </span>
        {choices.length > 1 && (
          <span className="dc-arrange-bar-direction">
            <SegmentedControl
              name="arrange-direction"
              legend="Reading direction"
              value={preview.direction}
              options={choices}
              onChange={(direction) => {
                const latest = useUiStore.getState().arrangePreview;
                if (latest) useUiStore.getState().setArrangePreview({ ...latest, direction });
              }}
            />
            <span className="dc-tidy-bar-summary">{directionNote(preview)}</span>
          </span>
        )}
        <SegmentedControl
          name="arrange-show"
          legend="Show"
          value={preview.show}
          options={SHOWS}
          onChange={(next) => {
            const latest = useUiStore.getState().arrangePreview;
            if (latest) useUiStore.getState().setArrangePreview({ ...latest, show: next });
          }}
        />
        <span className="dc-tidy-bar-actions">
          <Button variant="quiet" title="Keep the diagram and the view as they were (Esc)" onClick={cancel}>
            Cancel
          </Button>
          <Button variant="solid" title="Apply this arrangement as one undo step (Enter)" onClick={() => apply(preview)}>
            Apply
          </Button>
        </span>
      </div>
      {notes.length > 0 && <LayoutNotes notes={notes} />}
    </Fragment>
  );
}

function unionBounds(a: DraftDocument, b: DraftDocument) {
  const one = boundsOf(a.nodes);
  const two = boundsOf(b.nodes);
  if (!one || !two) return one ?? two;
  const x = Math.min(one.x, two.x);
  const y = Math.min(one.y, two.y);
  return { x, y, width: Math.max(one.x + one.width, two.x + two.width) - x, height: Math.max(one.y + one.height, two.y + two.height) - y };
}

/** Whether the arrangement went in: not when the diagram changed under the preview. */
function applyArrange(preview: ArrangePreview): boolean {
  const ui = useUiStore.getState();
  const editor = useEditorStore.getState();
  const before = editor.history.past.at(-1);
  const applied = editor.commitArrange(preview);
  ui.setArrangePreview(null);
  if (!applied) {
    ui.notify(`The diagram changed. Choose ${preview.scoped ? 'Arrange selection' : 'Arrange diagram'} again.`);
    return false;
  }
  const entry = useEditorStore.getState().history.past.at(-1);
  if (!entry || entry === before) return true;
  ui.notify('Arranged.', 'info', {
    label: 'Undo',
    // Only while this is still the latest step: after anything else, Undo here would undo that.
    run: () => {
      const latest = useEditorStore.getState();
      if (latest.history.past.at(-1) === entry) latest.undo();
    },
  });
  return true;
}
