import { isQuotaError, StorageUnavailableError } from './DraftRepository';

/**
 * Why a save failed, as far as the person can act on it: the browser is out of room (free some, or
 * export), the connection to its storage is gone (nothing here will write again until a reload), or
 * something else (try again, and keep a copy). The repository throws specific errors; this is
 * where they stop being discarded.
 */
export type SaveFailure = 'full' | 'closed' | 'other';

export function saveFailureOf(error: unknown): SaveFailure {
  if (isQuotaError(error)) return 'full';
  if (error instanceof StorageUnavailableError) return 'closed';
  // IndexedDB refuses a transaction on a connection this tab (or the browser) already closed:
  // another tab upgraded the database, or the browser dropped it. Retrying cannot work.
  if (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'InvalidStateError') return 'closed';
  return 'other';
}

/** In plain words, for the status bar and what a screen reader announces. */
export function saveFailureMessage(failure: SaveFailure): string {
  switch (failure) {
    case 'full':
      return 'This browser is out of storage space, so this diagram isn’t saved. Export it, then free space by deleting diagrams in the Library.';
    case 'closed':
      return 'Draft Canvas lost its connection to this browser’s storage, so this diagram isn’t saved. Export it, then reload.';
    default:
      return 'Couldn’t save this diagram to this browser. Retry, or export it to keep a copy.';
  }
}

/**
 * What a failed Library action says ("rename that diagram"): the reason when the person can act on
 * it, never the old "may be full or unavailable" for every cause at once.
 */
export function storageFailureNotice(what: string, error: unknown): string {
  switch (saveFailureOf(error)) {
    case 'full':
      return `Couldn’t ${what}. This browser is out of storage space; free some by deleting diagrams, or export them first.`;
    case 'closed':
      return `Couldn’t ${what}. Draft Canvas lost its connection to this browser’s storage; reload the page.`;
    default:
      return `Couldn’t ${what}. This browser’s storage didn’t accept it; try again.`;
  }
}
