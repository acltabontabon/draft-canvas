import { useEffect } from 'react';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore, type TidyPreview } from '../../store/uiStore';
import { Button } from '../common/Button';
import { tidySummary } from './tidySummary';

/**
 * Apply or Cancel for a Tidy up preview: the one place a cleanup is decided. The canvas shows the
 * result on a tracing sheet (`TidyPreviewLayer`); this says what it changes and waits. Nothing has
 * happened to the diagram until Apply, and Apply is a single undo step.
 *
 * Enter applies and Escape cancels from anywhere but a text field, since the person's focus is on
 * the canvas they are judging, not on this bar. The preview is dropped the moment the room it was
 * worked out from changes (an edit, an undo, a collaborator's change, a step into another room):
 * it would be describing a diagram that is no longer there. Always mounted, so that dropping it
 * never depends on the bar happening to be on screen.
 */
export function TidyBar() {
  const preview = useUiStore((state) => state.tidyPreview);
  const document = useEditorStore((state) => state.document);
  const path = useEditorStore((state) => state.path);
  // Presenting, tracing a flow or a diagram turned read-only: nothing can be applied there, and a
  // sheet left over the canvas would be a preview with no way to answer it.
  const editing = useEditorStore((state) => state.mode === 'edit');
  const locked = useUiStore((state) => Boolean(state.readOnly || state.flowTrace));
  const editable = editing && !locked;
  const stale = preview !== null && (!editable || document !== preview.base || path !== preview.path);

  useEffect(() => {
    if (stale) useUiStore.getState().setTidyPreview(null);
  }, [stale]);

  useEffect(() => {
    if (!preview) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      // A button under focus keeps its own Enter: Cancel must cancel, not apply.
      if (event.key === 'Enter' && !(target instanceof HTMLButtonElement) && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        applyTidy(preview);
      } else if (event.key === 'Escape') {
        // Before the editor's own Escape, which would clear the selection or leave the room.
        event.preventDefault();
        event.stopPropagation();
        useUiStore.getState().setTidyPreview(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [preview]);

  if (!preview || stale) return null;
  const summary = tidySummary(preview);

  return (
    <div className="dc-tidy-bar" role="region" aria-label="Tidy up preview">
      <span className="dc-tidy-bar-text" role="status">
        <strong>{preview.scoped ? 'Tidy up selection' : 'Tidy up'}</strong>
        {summary && <span className="dc-tidy-bar-summary">{summary}</span>}
      </span>
      <span className="dc-tidy-bar-actions">
        <Button variant="quiet" title="Keep the diagram as it is (Esc)" onClick={() => useUiStore.getState().setTidyPreview(null)}>
          Cancel
        </Button>
        <Button variant="solid" title="Apply this cleanup as one undo step (Enter)" onClick={() => applyTidy(preview)}>
          Apply
        </Button>
      </span>
    </div>
  );
}

function applyTidy(preview: TidyPreview) {
  const ui = useUiStore.getState();
  const editor = useEditorStore.getState();
  const before = editor.history.past.at(-1);
  const applied = editor.commitTidy(preview);
  ui.setTidyPreview(null);
  if (!applied) {
    ui.notify('The diagram changed. Choose Tidy up again.');
    return;
  }
  const entry = useEditorStore.getState().history.past.at(-1);
  if (!entry || entry === before) return;
  ui.notify('Tidied up.', 'info', {
    label: 'Undo',
    // Only while this is still the latest step: after anything else, Undo here would undo that.
    run: () => {
      const latest = useEditorStore.getState();
      if (latest.history.past.at(-1) === entry) latest.undo();
    },
  });
}
