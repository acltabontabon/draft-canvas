import { Suspense, useEffect } from 'react';
import { retryableLazy } from '../../ui/common/retryableLazy';
import { PanelBoundary } from '../../ui/common/PanelBoundary';
import { warmModal } from '../../ui/common/modalLoader';
import { logDiagnostic } from '../../lib/diagnostics';
import { useUiStore } from '../../store/uiStore';
import { desktopStore } from '../store';
import { useDesktopController, useDesktopState } from '../useDesktop';

const load = () => import('./FileExplorerDialog');
const Explorer = retryableLazy(() => load().then((module) => ({ default: module.FileExplorerDialog })));
export function warmExplorer() {
  warmModal();
  void load().catch(() => {});
}

/** One explorer for Home, the gallery and the native menu, loaded only when needed. */
export function DesktopExplorer() {
  const { explorerMode, explorerSave } = useDesktopState();
  const controller = useDesktopController();
  useEffect(() => {
    if (explorerMode !== 'save') explorerSave?.cancel();
  }, [explorerMode, explorerSave]);
  if (!explorerMode) return null;
  const close = () => {
    // An Open completion can arrive after the person has already requested Save As. An older
    // view may dismiss only its own mode, never a newer chooser waiting on a save operation.
    const current = desktopStore.getSnapshot();
    if (current.explorerMode !== explorerMode) return;
    if (explorerMode === 'save') {
      if (current.explorerSave === explorerSave) explorerSave?.cancel();
    } else desktopStore.update({ explorerMode: null });
  };
  return <PanelBoundary onError={(error, stack) => {
    logDiagnostic(error, { operation: 'file-explorer' }, stack);
    Explorer.reset();
    close();
    useUiStore.getState().notify('The folder browser couldn’t open. Please try again.', 'error');
  }}><Suspense fallback={null}><Explorer.Component key={explorerMode} mode={explorerMode} saveRequest={explorerMode === 'save' ? explorerSave ?? undefined : undefined} controller={controller} onClose={close} /></Suspense></PanelBoundary>;
}
