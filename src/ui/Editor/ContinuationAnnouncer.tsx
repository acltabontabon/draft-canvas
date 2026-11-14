import { useUiStore } from '../../store/uiStore';
import { continuationAnnouncement } from './continuationAnnouncement';

/**
 * The one screen-reader-facing signal next-shape suggestions make: a polite announcement each time a
 * suggestion appears or changes, so a ghost that is only visual otherwise is still discoverable
 * without a pointer. The text is a pure function of what is showing, so a suggestion that merely
 * stays put while the diagram changes elsewhere is not repeated — but one that goes away (a drag, an
 * Escape, another selection) and comes back is announced again, which is what someone who cannot see
 * it needs: it is, for them, a new thing each time.
 */
export function ContinuationAnnouncer() {
  const message = useUiStore(continuationAnnouncement);
  return (
    <div className="dc-sr-only" aria-live="polite">
      {message}
    </div>
  );
}
