import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createPanelApi } from '../tauri/panel';
import { TrayPanel } from './TrayPanel';

import '../../styles/tokens.css';
import '../../styles/app.css';
import './tray.css';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element.');

createRoot(container).render(
  <StrictMode>
    <TrayPanel api={createPanelApi()} />
  </StrictMode>,
);
