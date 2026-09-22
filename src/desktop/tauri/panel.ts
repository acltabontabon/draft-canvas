import { invoke } from '@tauri-apps/api/core';

/**
 * Everything the tray panel may ask the shell (`capabilities/tray.json`): what to list, how each
 * diagram looks, how tall to be, and which of the tray's own items was chosen. It can't write, and
 * it names files only by the handles the shell listed.
 */

export interface PanelRecent {
  /** What `choose` takes to open it. */
  choice: string;
  handle: string;
  name: string;
  openedMs: number;
}

export interface PanelDraft {
  choice: string;
  id: string;
  title: string;
  updatedMs: number | null;
}

export interface PanelState {
  recents: PanelRecent[];
  drafts: PanelDraft[];
}

/** The tray's own items; a recent file or a draft is chosen by its `choice`. */
export type PanelChoice =
  | 'tray:new-quick-draft'
  | 'tray:new-canvas'
  | 'tray:open'
  | 'tray:open-project'
  | 'tray:show'
  | 'tray:settings'
  | 'tray:quit'
  | 'panel:dismiss';

export interface PanelApi {
  state(): Promise<PanelState>;
  choose(choice: PanelChoice | string): Promise<void>;
  fit(height: number): Promise<void>;
  peekDocument(handle: string): Promise<string | null>;
  readDraft(id: string): Promise<string | null>;
}

export function createPanelApi(): PanelApi {
  return {
    state: () => invoke<PanelState>('tray_panel'),
    choose: (choice) => invoke('tray_choose', { choice }),
    fit: (height) => invoke('tray_panel_fit', { height }),
    peekDocument: (handle) => invoke<string | null>('peek_document', { handle }),
    readDraft: async (id) => (await invoke<{ text: string }>('recovery_read', { id })).text,
  };
}
