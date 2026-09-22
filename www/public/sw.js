/*
 * The service worker that retires the service worker.
 *
 * Until the editor moved to /draft-canvas/editor/, the app registered a Workbox worker at
 * /draft-canvas/sw.js whose scope covered this whole path and whose `navigateFallback` answered
 * *every* navigation in that scope with the precached editor shell. Left alone, it would keep
 * serving the old editor page at the marketing address for anyone who has ever opened Draft Canvas
 * in this browser. This file replaces it at its own URL, takes itself out of the picture, and never
 * comes back — the editor registers its own worker at its new address, scoped to /editor/.
 *
 * It is deliberately surgical. acltabontabon.com is one origin shared with Scuttle, Vortex and the
 * personal site: a blanket `caches.keys()` sweep, a `localStorage.clear()`, or an
 * `indexedDB.deleteDatabase` here would take their data with it. So the only thing deleted is a
 * cache whose own name contains this worker's scope — which is exactly how Workbox names them
 * (`workbox-precache-v2-https://acltabontabon.com/draft-canvas/`) and no way anything else is
 * named. No storage of any other kind is touched, and nothing anyone has drawn lives in a cache
 * regardless: diagrams are in IndexedDB, which this never opens.
 */

// The previous worker shipped `skipWaiting: false`, so it will not stand aside on its own. A new
// worker may always skip its own wait, which is what lets this one retire on the update check
// instead of lingering behind a prompt nobody will see.
self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    (async function () {
      const scope = self.registration.scope;
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.includes(scope))
          .map((name) => caches.delete(name).catch(() => false)),
      );

      // No `clients.claim()` and no `client.navigate()`. A tab that is still running the old editor
      // at this address keeps running it for the rest of its session rather than being reloaded out
      // from under whoever is drawing in it; its next navigation goes to the network like any other.
      await self.registration.unregister();
    })(),
  );
});

// No `fetch` listener at all: every request goes to the network, which is the whole point.
