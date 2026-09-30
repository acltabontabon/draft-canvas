import type { DraftDocument } from '../document/types';
import { parseDocument } from '../document/validate';

/**
 * The edits a page would otherwise lose on the way out.
 *
 * IndexedDB cannot be trusted from `pagehide`: a document being unloaded force-closes its
 * connection, and every transaction still open is aborted — including one whose requests were all
 * queued before the event fired (seen in Chromium: read, write, write, then nothing on disk). The
 * autosave's flush from there is worth trying, but a refresh straight after an edit came back
 * without the edit every time.
 *
 * `sessionStorage` is synchronous, survives a refresh and same-tab navigation, and dies with the
 * tab — which is exactly the case it is for: the page that closes is the page that reopens. Not a
 * store (see `lib/preferences.ts` for why documents never live in web storage): one entry, written
 * only as the page leaves, read back once, and gone. Too large to fit means nothing is stashed and
 * the flush stays the only chance, as before.
 */
const PREFIX = 'draft-canvas:reload:';

export function stashForReload(document: DraftDocument): void {
  try {
    window.sessionStorage.setItem(PREFIX + document.metadata.id, JSON.stringify(document));
  } catch {
    // Quota, or storage blocked: the write in flight is all there is.
  }
}

/** The stash for a canvas, once — removed as it is read, whether or not it is usable. */
export function takeReloadStash(id: string): DraftDocument | null {
  try {
    const key = PREFIX + id;
    const text = window.sessionStorage.getItem(key);
    if (text === null) return null;
    window.sessionStorage.removeItem(key);
    const result = parseDocument(text);
    return result.ok && result.document.metadata.id === id ? result.document : null;
  } catch {
    return null;
  }
}
