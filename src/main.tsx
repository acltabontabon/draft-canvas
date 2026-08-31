import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initServiceWorker } from './lib/serviceWorker';
import { useUiStore } from './store/uiStore';

import '@xyflow/react/dist/base.css';
import './styles/tokens.css';
import './styles/app.css';
import './styles/canvas.css';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element.');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Offline app-shell caching (Phase 6). Registered after the initial render so
// it never delays first paint; the returned activate function only ever runs
// on the user's own explicit "Update ready" action (see AboutDialog.tsx).
const activateUpdate = initServiceWorker(() => useUiStore.getState().setUpdateReady());
useUiStore.getState().registerActivateUpdate(activateUpdate);
