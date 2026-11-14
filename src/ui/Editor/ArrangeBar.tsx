import { useReactFlow, useStore as useReactFlowStore } from '@xyflow/react';
import { useEffect } from 'react';
import { focusBoundsInView } from '../../commands/search';
import { boundsOf } from '../../document/geometry';
import type { DraftDocument } from '../../document/types';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore, type ArrangeDirection, type ArrangePreview } from '../../store/uiStore';
import { Button } from '../common/Button';
import { SegmentedControl } from '../common/SegmentedControl';
import { directionNote, readsAs } from './arrangeSummary';

const DIRECTIONS: { value: ArrangeDirection; label: string; name: string }[] = [
  { value: 'right', label: 'Across →', name: 'Across, left to right' },
  { value: 'down', label: 'Down ↓', name: 'Down, top to bottom' },
];

/**
 * Apply or Cancel for an Arrange preview, and the reading direction to arrange in: the room laid out
 * again from scratch is a bigger change than Tidy up's, so it is shown first and chosen, never just
 * done. The canvas shows the result on a tracing sheet (`ArrangePreviewLayer`); the camera frames it,
 * and frames it again when the direction changes, since the two can be very different shapes.
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
  const { setViewport } = useReactFlow();
  const viewWidth = useReactFlowStore((state) => state.width);
  const viewHeight = useReactFlowStore((state) => state.height);
  const shown = preview && !stale ? preview.options[preview.direction] : undefined;

  useEffect(() => {
    if (stale) useUiStore.getState().setArrangePreview(null);
  }, [stale]);

  // The whole of what would change, before and after, in view — read once per arrangement shown,
  // not on every resize of the pane.
  useEffect(() => {
    if (!shown || !preview) return;
    focusBoundsInView({ viewWidth, viewHeight, setViewport }, unionBounds(preview.base, shown));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- framed once per arrangement shown, not on every pane resize
  }, [shown]);

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
        applyArrange(preview);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        useUiStore.getState().setArrangePreview(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [preview]);

  if (!preview || stale) return null;
  const choices = DIRECTIONS.filter((d) => preview.options[d.value]);

  return (
    <div className="dc-tidy-bar dc-arrange-bar" role="region" aria-label="Arrange preview">
      <span className="dc-tidy-bar-text" role="status">
        <strong>{preview.scoped ? 'Arrange selection' : 'Arrange'}</strong>
        {choices.length < 2 && <span className="dc-tidy-bar-summary">{readsAs(preview.direction)}</span>}
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
      <span className="dc-tidy-bar-actions">
        <Button variant="quiet" title="Keep the diagram as it is (Esc)" onClick={() => useUiStore.getState().setArrangePreview(null)}>
          Cancel
        </Button>
        <Button variant="solid" title="Apply this arrangement as one undo step (Enter)" onClick={() => applyArrange(preview)}>
          Apply
        </Button>
      </span>
    </div>
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

function applyArrange(preview: ArrangePreview) {
  const ui = useUiStore.getState();
  const editor = useEditorStore.getState();
  const before = editor.history.past.at(-1);
  const applied = editor.commitArrange(preview);
  ui.setArrangePreview(null);
  if (!applied) {
    ui.notify(`The diagram changed. Choose ${preview.scoped ? 'Arrange selection' : 'Arrange diagram'} again.`);
    return;
  }
  const entry = useEditorStore.getState().history.past.at(-1);
  if (!entry || entry === before) return;
  ui.notify('Arranged.', 'info', {
    label: 'Undo',
    // Only while this is still the latest step: after anything else, Undo here would undo that.
    run: () => {
      const latest = useEditorStore.getState();
      if (latest.history.past.at(-1) === entry) latest.undo();
    },
  });
}
