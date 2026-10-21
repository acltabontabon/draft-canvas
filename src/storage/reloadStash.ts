import type { DraftDocument } from '../document/types';
import { parseDocument } from '../document/validate';
import type { SharedMetadata } from './DraftRepository';

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
/** Beside the document, what it was based on — see `ReloadStash`. A separate entry, so a stash
 *  written before it existed still reads as a plain document. */
const CONTEXT_PREFIX = 'draft-canvas:reload-context:';

export interface ReloadStashContext {
  /** The title/project the editor last loaded or wrote, so reopening keeps a rename made elsewhere
   *  meanwhile instead of reverting it (`DraftRepository.save`'s `base`). */
  base?: SharedMetadata;
  /** The stored row's content stamp the edits were made over (`DraftRepository.knownContentStamp`). */
  stamp?: string;
}

export interface ReloadStash extends ReloadStashContext {
  document: DraftDocument;
}

export function stashForReload(document: DraftDocument, context: ReloadStashContext = {}): void {
  try {
    const id = document.metadata.id;
    window.sessionStorage.setItem(PREFIX + id, JSON.stringify(document));
    if (context.base || context.stamp !== undefined) window.sessionStorage.setItem(CONTEXT_PREFIX + id, JSON.stringify(context));
    else window.sessionStorage.removeItem(CONTEXT_PREFIX + id);
  } catch {
    // Quota, or storage blocked: the write in flight is all there is.
  }
}

/** Read defensively: sessionStorage is this tab's own, but a malformed entry must not cost the stash. */
function readContext(text: string | null): ReloadStashContext {
  if (text === null) return {};
  try {
    const raw = JSON.parse(text) as Record<string, unknown> | null;
    if (!raw || typeof raw !== 'object') return {};
    const context: ReloadStashContext = {};
    const base = raw.base as Record<string, unknown> | undefined;
    if (base && typeof base === 'object' && typeof base.title === 'string') {
      context.base = typeof base.projectId === 'string' ? { title: base.title, projectId: base.projectId } : { title: base.title };
    }
    if (typeof raw.stamp === 'string') context.stamp = raw.stamp;
    return context;
  } catch {
    return {};
  }
}

/** The stash for a canvas, once — removed as it is read, whether or not it is usable. */
export function takeReloadStash(id: string): ReloadStash | null {
  try {
    const key = PREFIX + id;
    const text = window.sessionStorage.getItem(key);
    const context = readContext(window.sessionStorage.getItem(CONTEXT_PREFIX + id));
    window.sessionStorage.removeItem(CONTEXT_PREFIX + id);
    if (text === null) return null;
    window.sessionStorage.removeItem(key);
    const result = parseDocument(text);
    return result.ok && result.document.metadata.id === id ? { ...context, document: result.document } : null;
  } catch {
    return null;
  }
}
