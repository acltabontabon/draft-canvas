import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { isRetiredHostVisit } from './lib/retiredHost';
import { RetiredHostNotice } from './ui/RetiredHostNotice';
import { initServiceWorker } from './lib/serviceWorker';
import { flushAllAutosaves } from './storage/autosave';
import { useUiStore } from './store/uiStore';

import '@xyflow/react/dist/base.css';
import './styles/tokens.css';
import './styles/app.css';
import './styles/canvas.css';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element.');

// A copy of the retired VS Code extension (0.1.x) frames the editor at `?host=vscode` and waits for a
// protocol nobody speaks any more. It gets a page that says so, and where the file opens now — and
// never the editor, whose Library would open this origin's storage inside somebody's IDE.
if (isRetiredHostVisit()) {
  createRoot(container).render(
    <StrictMode>
      <RetiredHostNotice />
    </StrictMode>,
  );
} else {
  // In the desktop app the shell is up before the first paint, so the first thing shown is Home or
  // the file the OS opened. `__DESKTOP__` is false in the web build, which drops all of this.
  if (__DESKTOP__) {
    const { bootDesktop } = await import('./desktop/boot');
    await bootDesktop();
  }

  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

/** A reload with unsaved work would silently drop it (a pending cross-tab conflict, a full disk, a
 *  closed connection) — so it stays a choice the user makes, with Export still one click away. */
function warnUnsavedBeforeReload(reloadAnyway: () => void): void {
  useUiStore.getState().notify("Your latest changes aren't saved. Export the diagram first, or reload anyway.", 'error', {
    label: 'Reload anyway',
    run: reloadAnyway,
  });
}

// Offline app-shell caching. Registered after the initial render so
// it never delays first paint; the returned activate function only ever runs
// on the user's own explicit "Reload to update" action (see AboutDialog.tsx).
const activateUpdate = initServiceWorker(
  {
    onUpdateReady: () => useUiStore.getState().setUpdateReady(),
    onUpdatedElsewhere: () =>
      useUiStore.getState().notify('Draft Canvas was updated in another tab.', 'info', {
        label: 'Reload',
        run: () =>
          void flushAllAutosaves().then((saved) => {
            const reload = () => window.location.reload();
            if (saved) reload();
            else warnUnsavedBeforeReload(reload);
          }),
      }),
    onUnsavedWork: warnUnsavedBeforeReload,
  },
  flushAllAutosaves,
);
useUiStore.getState().registerActivateUpdate(activateUpdate);
