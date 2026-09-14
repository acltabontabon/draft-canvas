import { registerSW } from 'virtual:pwa-register';

/** A long-lived tab still hears about a deploy: the browser otherwise only checks on navigation. */
const UPDATE_CHECK_MS = 60 * 60 * 1000;

export interface ServiceWorkerCallbacks {
  /** A new version has downloaded and is waiting. */
  onUpdateReady: () => void;
  /** Another tab activated the new version. This page still runs the old one, and its requests for
   *  code it hasn't loaded yet may now fail — it should offer a reload rather than be reloaded. */
  onUpdatedElsewhere: () => void;
  /** The saves before an update reload didn't all land. This tab is left running — reloading now
   *  would throw that work away — and `reloadAnyway` is what an explicit second choice calls. */
  onUnsavedWork?: (reloadAnyway: () => void) => void;
}

/**
 * Registers the offline app-shell Service Worker and reports back once a new version has finished
 * downloading, without ever activating it itself. The returned function is the only thing that
 * does — see `AboutDialog.tsx`'s update action — and it reloads only the tab it was called from,
 * after that tab's saves have landed. Every other open tab is told, and keeps its work on screen.
 *
 * Best-effort like the rest of `src/lib/`: unsupported browsers and registration failures are
 * silently ignored rather than surfaced to the user, since offline availability is a bonus, not a
 * requirement.
 */
export function initServiceWorker(
  callbacks: ServiceWorkerCallbacks,
  beforeReload: () => Promise<boolean | void> = async () => {},
): (() => void) | null {
  if (!('serviceWorker' in navigator)) return null;

  let requestedHere = false;
  try {
    const updateSW = registerSW({
      immediate: false,
      onNeedRefresh: callbacks.onUpdateReady,
      // Without this, vite-plugin-pwa reloads *every* tab that had seen the update the moment any one
      // of them activates it — mid-edit, undo history and all.
      onNeedReload: () => {
        if (requestedHere) window.location.reload();
        else callbacks.onUpdatedElsewhere();
      },
      onRegisteredSW: (_url, registration) => {
        if (!registration) return;
        setInterval(() => void registration.update().catch(() => {}), UPDATE_CHECK_MS);
      },
    });
    const reload = () => {
      requestedHere = true;
      void updateSW(true);
    };
    return () => {
      void beforeReload()
        .catch(() => false)
        .then((saved) => {
          if (saved === false && callbacks.onUnsavedWork) callbacks.onUnsavedWork(reload);
          else reload();
        });
    };
  } catch {
    return null;
  }
}
