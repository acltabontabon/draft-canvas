import { loadFailureNotice } from '../../lib/staleChunk';
import { useUiStore } from '../../store/uiStore';

/**
 * The toast for an action whose on-demand chunk (or the work after it) failed — the `.catch` of a
 * fire-and-forget `import()`, so the failure is said rather than left as an unhandled rejection.
 * A stale page is offered a reload; anything else keeps `offlineMessage`.
 */
export function notifyLoadFailure(error: unknown, offlineMessage: string): void {
  const notice = loadFailureNotice(error, offlineMessage);
  useUiStore.getState().notify(notice.message, 'error', notice.action);
}

/** Arrange's layout engine loads on demand (the palette's command and the toolbar's row share this). */
export const ARRANGE_FAILED = 'Arrange couldn’t run. Check your connection and try again.';
