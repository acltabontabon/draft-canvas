import { setFileSaver } from '../export/download';
import { registerDesktopHost } from '../host/hostInfo';
import { logDiagnostic } from '../lib/diagnostics';
import { useUiStore } from '../store/uiStore';
import { DesktopError, type DesktopApi } from './api';
import { createHostLink } from './channel';
import { dispatchEditCommand } from './commands';
import { DesktopController, type DesktopUi } from './controller';
import { desktopStore } from './store';
import { createTauriApi } from './tauri/api';
import { startTrayArt } from './trayArt';
import { setDesktopController } from './useDesktop';

/** Exports go through the shell's Save dialog. Cancelling it rejects the way the export dialog expects a cancel to. */
function fileSaverFor(api: DesktopApi) {
  return async (blob: Blob, fileName: string): Promise<void> => {
    const dot = fileName.lastIndexOf('.');
    const extension = dot > 0 ? fileName.slice(dot + 1) : '';
    const filters = extension ? [{ name: extension.toUpperCase(), extensions: [extension] }] : [];
    try {
      if (!(await api.exportFile(fileName, filters, new Uint8Array(await blob.arrayBuffer())))) {
        throw new DOMException('The export was cancelled.', 'AbortError');
      }
    } catch (error) {
      if (error instanceof DesktopError) throw new Error(error.message);
      throw error;
    }
  };
}

const ui: DesktopUi = {
  openAbout: () => useUiStore.getState().setAboutOpen(true),
  openShortcuts: () => useUiStore.getState().setShortcutsOpen(true),
  openSettings: () => desktopStore.update({ settingsOpen: true }),
  notify: (message, action) => useUiStore.getState().notify(message, 'info', action),
  editCommand: dispatchEditCommand,
  openRename: () => {
    const { doc } = desktopStore.getSnapshot();
    if (doc.kind === 'file') {
      desktopStore.update({ renameTarget: { kind: 'open' } });
      return;
    }
    // A draft has no file to rename yet: its name is its diagram title, so "Rename draft" is editing
    // that, the same field Home's suggestion for the first Save reads from.
    if (doc.kind === 'quick') {
      const input = document.querySelector<HTMLInputElement>('.dc-title-input');
      if (input) {
        input.focus();
        input.select();
      } else {
        useUiStore.getState().notify('Nothing is open to rename yet.');
      }
    }
  },
};

/**
 * Starts the desktop shell's half of the app before anything renders, so the first thing shown is
 * Home (or the file the OS asked for) rather than the browser's Library. If the shell can't be
 * reached the app falls back to being the web app in a window, which still works — and says why.
 */
export async function bootDesktop(): Promise<void> {
  try {
    const api = createTauriApi();
    const { channel, link } = createHostLink();
    const controller = new DesktopController({ api, link, store: desktopStore, ui });
    setDesktopController(controller);
    registerDesktopHost({ channel, returnHome: () => void controller.returnHome() });
    setFileSaver(fileSaverFor(api));
    await controller.start();
    // The tray menu's drawings follow Home's lists from here on; it runs for the life of the app.
    startTrayArt(api, desktopStore, controller);
  } catch (error) {
    logDiagnostic(error, { operation: 'desktop-boot' });
    setDesktopController(null);
    registerDesktopHost(null);
    setFileSaver(null);
  }
}
