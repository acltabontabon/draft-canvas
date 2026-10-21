/**
 * The old front door's two jobs, both optional: the page reads and every link works without them.
 *
 * 1. Retire the editor's very first service worker, which once answered every navigation under
 *    /draft-canvas/ with the editor shell (sw.js beside this file is the other half of that job).
 * 2. Notice that this browser has drawn here, and make bringing those diagrams along the first
 *    thing on the page. Nothing is opened or read to find out.
 */

/**
 * Takes the editor's former registration out of the picture, from the page's side.
 *
 * It is written to be incapable of touching anything else. acltabontabon.com is one origin shared
 * with other projects, so there is no blanket sweep here: the only registration considered is the
 * one whose scope is exactly this page's own directory, and the only caches deleted are the ones
 * whose names contain that scope — which is how Workbox names them and how nothing else is named.
 * No IndexedDB is opened, no storage key is read, nothing anyone has drawn is anywhere near this.
 */
async function retireFormerWorker() {
  if (!('serviceWorker' in navigator)) return;
  const here = new URL('./', window.location.href).href;

  try {
    for (const registration of await navigator.serviceWorker.getRegistrations()) {
      if (registration.scope !== here) continue; // the editor's own worker is at ./editor/ — leave it
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.includes(here))
          .map((name) => caches.delete(name).catch(() => false)),
      );
      await registration.unregister();
    }
  } catch {
    // Unsupported, or storage is blocked. The page is already the right one; this was only tidying.
  }
}

/**
 * Has this browser been used to draw here?
 *
 * A preference key is the reliable signal: the app writes `draft-canvas.personality` and
 * `draft-canvas.last-seen-product-release` the first time it runs, it is synchronous, and it works
 * everywhere. `indexedDB.databases()` is the stronger signal but Firefox does not implement it, so
 * it only ever corroborates. Neither opens a database or reads a single thing anyone has drawn.
 */
function hasPreferences() {
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      if (localStorage.key(index)?.startsWith('draft-canvas.')) return true;
    }
  } catch {
    // Storage blocked (a private window, third-party restrictions). Treat as a first visit.
  }
  return false;
}

async function hasDiagrams() {
  try {
    if (typeof indexedDB.databases !== 'function') return false;
    return (await indexedDB.databases()).some((database) => database.name === 'draft-canvas');
  } catch {
    return false;
  }
}

async function surfaceTheirDiagrams() {
  const note = document.getElementById('yours');
  const title = document.getElementById('yours-title');
  if (!note || !title) return;
  if (!(hasPreferences() || (await hasDiagrams()))) return;

  note.dataset.found = '';
  title.textContent = 'Your diagrams are still here.';
  // Above the forwarding address: for this visitor, it is the reason to be on this page at all.
  document.querySelector('.label')?.before(note);
}

void retireFormerWorker();
void surfaceTheirDiagrams();
