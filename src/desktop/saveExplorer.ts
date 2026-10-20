import type { DesktopApi, ExplorerSaveResult, SavedAs, StartLocation } from './api';
import type { DesktopStore } from './store';

/** The save operation owns the bytes; the view only chooses a folder, name and confirmation. */
export interface ExplorerSaveRequest {
  suggestedName: string;
  startIn?: StartLocation;
  save(session: string, folder: string, name: string, expectedStamp?: string): Promise<ExplorerSaveResult>;
  cancel(): void;
}

/** Keep the controller's existing save/close/conflict flows waiting on the in-app chooser, just as
 * they waited on a native picker. Resolve only after a successful write or explicit cancellation. */
export function createExplorerSaver(api: Pick<DesktopApi, 'explorerSaveFile'>, store: DesktopStore): DesktopApi['saveAs'] {
  return (suggestedName, bytes, copySidecarFrom, startIn) => new Promise<SavedAs | null>((resolve) => {
    store.getSnapshot().explorerSave?.cancel();
    let settled = false;
    let writing = false;
    const finish = (saved: SavedAs | null) => {
      if (settled) return;
      settled = true;
      if (store.getSnapshot().explorerSave === request) {
        const mode = store.getSnapshot().explorerMode;
        store.update({ explorerSave: null, explorerMode: mode === 'save' ? null : mode });
      }
      resolve(saved);
    };
    const request: ExplorerSaveRequest = {
      suggestedName,
      startIn,
      async save(session, folder, name, expectedStamp) {
        if (settled) throw new Error('This save has been closed. Choose Save As again.');
        if (writing) throw new Error('This diagram is already being saved.');
        writing = true;
        try {
          const result = await api.explorerSaveFile(session, folder, name, bytes, copySidecarFrom, expectedStamp);
          if (result.outcome === 'saved') finish(result.saved);
          return result;
        } finally { writing = false; }
      },
      cancel: () => finish(null),
    };
    store.update({ explorerMode: 'save', explorerSave: request });
  });
}
