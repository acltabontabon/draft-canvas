/**
 * The open canvas in the address bar: `#doc=<id>`. Without it a refresh — or a Back press, or a
 * bookmark — always landed on the Library, whatever you were working on; there was no way to come
 * back to a diagram except finding it again.
 *
 * A fragment, not a path or a query: the app has no router and is served from any path
 * (`base: './'`), and a fragment never reaches the server or the service worker. The web app only —
 * the desktop app opens files, and an embedded host owns its own navigation.
 */

const KEY = 'doc';

/** The canvas the address names, if any. */
export function docIdFromLocation(location: Pick<Location, 'hash'> = window.location): string | null {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  const id = params.get(KEY);
  return id && id.length <= 128 ? id : null;
}

function urlFor(id: string | null): string {
  const url = new URL(window.location.href);
  const params = new URLSearchParams(url.hash.replace(/^#/, ''));
  if (id) params.set(KEY, id);
  else params.delete(KEY);
  const hash = params.toString();
  return `${url.pathname}${url.search}${hash ? `#${hash}` : ''}`;
}

/** Marks history entries this module made, so closing a canvas can step back over its own entry. */
interface DocState {
  draftCanvasDoc: string;
}

function isDocState(value: unknown): value is DocState {
  return typeof value === 'object' && value !== null && typeof (value as DocState).draftCanvasDoc === 'string';
}

/** A canvas was opened: a new history entry, so Back returns to the Library. */
export function pushDocUrl(id: string): void {
  if (docIdFromLocation() === id) return;
  window.history.pushState({ draftCanvasDoc: id } satisfies DocState, '', urlFor(id));
}

/**
 * The canvas was closed from inside the app. When the entry was one `pushDocUrl` made, step back over
 * it — the address then shows the Library, and Forward reopens the canvas. Otherwise (arrived straight
 * at a `#doc=` address) replace it, rather than leave the tab with nowhere to go Back to.
 */
export function clearDocUrl(): void {
  const id = docIdFromLocation();
  if (!id) return;
  if (isDocState(window.history.state) && window.history.state.draftCanvasDoc === id) window.history.back();
  else window.history.replaceState(null, '', urlFor(null));
}

/** The address named a canvas this browser doesn't have: forget it without adding an entry. */
export function replaceDocUrl(id: string | null): void {
  window.history.replaceState(id ? ({ draftCanvasDoc: id } satisfies DocState) : null, '', urlFor(id));
}
