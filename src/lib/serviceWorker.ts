import { registerSW } from 'virtual:pwa-register';

/**
 * Registers the offline app-shell Service Worker (Phase 6) and reports back
 * once a new version has finished downloading, without ever activating it
 * itself. `updateSW(true)` is the only thing that ever triggers `skipWaiting`
 * and a reload — see `AboutDialog.tsx`'s "Update ready" action — so a
 * background deployment never interrupts a session in progress.
 *
 * Best-effort like the rest of `src/lib/`: unsupported browsers and
 * registration failures are silently ignored rather than surfaced to the
 * user, since offline availability is a bonus, not a requirement.
 */
export function initServiceWorker(onUpdateReady: () => void): (() => void) | null {
  if (!('serviceWorker' in navigator)) return null;

  try {
    const updateSW = registerSW({
      immediate: false,
      onNeedRefresh: onUpdateReady,
    });
    return () => {
      void updateSW(true);
    };
  } catch {
    return null;
  }
}
