import { useUiStore } from '../../store/uiStore';
import { Button } from '../common/Button';

/**
 * Arrange or Tidy up while it is being worked out: said, with a Cancel, in the place its preview bar
 * will take. The work runs off the page's thread (`agent/offThread.ts`), so the editor stays usable
 * and this is not a modal; a diagram that is already tidy answers before it is ever seen. Always
 * mounted, like the bars it leads to.
 */
export function LayoutBusyBar() {
  const busy = useUiStore((state) => state.layoutBusy);
  if (!busy) return null;
  const what = busy.kind === 'tidy' ? 'Tidying' : 'Arranging';
  return (
    <div className="dc-tidy-bar dc-layout-busy" role="region" aria-label={`${what} progress`}>
      <span className="dc-tidy-bar-text" role="status">
        <strong>{busy.scoped ? `${what} selection…` : `${what}…`}</strong>
        <span className="dc-tidy-bar-summary">Nothing changes until you apply the result.</span>
      </span>
      <span className="dc-tidy-bar-actions">
        <Button variant="quiet" title="Stop and keep the diagram as it is" onClick={busy.cancel}>
          Cancel
        </Button>
      </span>
    </div>
  );
}

/** What a preview did not do or leaves alone, as one small line above its bar. */
export function LayoutNotes({ notes }: { notes: readonly string[] }) {
  return (
    <div className="dc-tidy-bar-notes" role="status">
      {notes.join(' ')}
    </div>
  );
}
