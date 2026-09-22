import type { DesktopSettings, ProjectFile, ProjectInfo, RecentItem, RecoveryEntry, UpdateSnapshot } from './api';

/** What the open document is, for the status bar, the window title and Home. */
export type DesktopDoc =
  | { kind: 'none' }
  | { kind: 'quick'; dirty: boolean }
  | {
      kind: 'file';
      name: string;
      displayPath: string;
      dirty: boolean;
      readOnly: boolean;
      /** The file was changed or removed outside the app while it was open. */
      outside?: 'changed' | 'missing';
    };

export interface DesktopState {
  /** The shell has answered `host_ready`; Home has what it needs to draw. */
  ready: boolean;
  platform: 'macos' | 'windows' | 'linux' | null;
  doc: DesktopDoc;
  saving: boolean;
  project: { info: ProjectInfo; files: ProjectFile[]; truncated: boolean; loading: boolean } | null;
  recents: RecentItem[];
  recovery: RecoveryEntry[];
  settings: DesktopSettings;
  settingsOpen: boolean;
  /** Where an update stands, as the shell last said. Null until it has. */
  update: UpdateSnapshot | null;
  /** The update panel is open. */
  updateOpen: boolean;
}

const INITIAL: DesktopState = {
  ready: false,
  platform: null,
  doc: { kind: 'none' },
  saving: false,
  project: null,
  recents: [],
  recovery: [],
  settings: { closeBehavior: 'ask', autoCheckUpdates: true },
  settingsOpen: false,
  update: null,
  updateOpen: false,
};

/**
 * A small external store, read with `useSyncExternalStore` (see `useDesktopState`). Home and the
 * status bar only ever read it; the controller is the one thing that writes.
 */
export class DesktopStore {
  private state: DesktopState = INITIAL;
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): DesktopState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  update(patch: Partial<DesktopState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }
}

/** The one the app reads. Tests build their own `DesktopStore` and hand it to the controller. */
export const desktopStore = new DesktopStore();

