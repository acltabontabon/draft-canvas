import { flushAllAutosaves } from '../storage/autosave';

/** The shape `uiStore`'s `ToastAction` has, restated so this module stays a leaf. */
interface ReloadAction {
  label: string;
  run: () => void;
}

export interface LoadFailureNotice {
  message: string;
  action?: ReloadAction;
}

/**
 * Whether a panel failed to open because this page is out of date rather than because the network
 * is.
 *
 * Every lazily loaded panel is a content-hashed file, and a deploy removes the previous one. A tab
 * left open across a deploy therefore holds an index that names chunks the server no longer has:
 * the app keeps working, and then the first Export, Learn or About asks for a file that is now a
 * 404 page. `retryableLazy`'s `reset()` was written for this, but it can only try the same dead URL
 * again — nothing short of reloading can fix it, because the fix is a newer index.
 *
 * It bit hardest where a document lives longest. Draft Canvas for VS Code frames the hosted editor
 * in a webview that is kept alive deliberately (`retainContextWhenHidden`), so a browser tab's
 * "reload and it sorts itself out" never comes around, and the panel stays broken for good.
 */
export function isStaleChunkError(error: unknown): boolean {
  const described = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  // Each engine words it differently, and none of them types it: Chrome and Vite say "Failed to
  // fetch dynamically imported module", Safari "Importing a module script failed", Firefox "error
  // loading dynamically imported module", bundler runtimes "ChunkLoadError".
  return /dynamically imported module|Importing a module script failed|ChunkLoadError/i.test(described);
}

/**
 * What to tell someone whose panel didn't open. A stale page is offered the one thing that fixes
 * it; anything else keeps the message it had, because reloading would not help and saying so would
 * send them round a loop.
 *
 * Reloading is never automatic. It is the user's click, on a page that is still working — and what
 * is on screen may be seconds newer than what has been written, so the reload waits for the
 * autosaves to land rather than racing them.
 */
export function loadFailureNotice(error: unknown, offlineMessage: string): LoadFailureNotice {
  if (!isStaleChunkError(error)) return { message: offlineMessage };
  return {
    message: 'Draft Canvas has been updated. Reload to open this.',
    action: {
      label: 'Reload',
      run: () => {
        void flushAllAutosaves().finally(() => window.location.reload());
      },
    },
  };
}
