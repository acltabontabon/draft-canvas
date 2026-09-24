import type { AgentSettings, DesktopSettings, Handle, ProjectFile, ProjectInfo, RecentItem, RecoveryEntry, UpdateSnapshot } from './api';

/**
 * "Rename file…", wherever it was asked for: the file open right now (its name comes from `doc`, not
 * carried here), a Recent entry, or a file Find a Diagram has only ever scanned. One dialog, rendered
 * once, reads whichever of these is set.
 */
export type RenameTarget =
  | { kind: 'open' }
  | { kind: 'recent'; handle: Handle; name: string }
  | { kind: 'project'; project: Handle; relPath: string; name: string };

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

/**
 * One project folder: its name and place, and — once something has shown it — the diagrams in it, by
 * name and date. `unscanned` until then, so a list of fifty projects costs nothing until it's looked at.
 */
export interface ProjectState {
  info: ProjectInfo;
  status: 'unscanned' | 'scanning' | 'ready' | 'missing';
  files: ProjectFile[];
  /** The relative path of every folder whose contents weren't fully listed because a limit was hit — the
   * project root itself is `''`. Empty when nothing was cut off. */
  truncatedDirs: string[];
}

export interface DesktopState {
  /** The shell has answered `host_ready`; Home has what it needs to draw. */
  ready: boolean;
  /**
   * Recents and drafts have been listed once. Until then Home can't tell a first run from a return
   * visit, so it draws neither hero rather than the wrong one.
   */
  listed: boolean;
  platform: 'macos' | 'windows' | 'linux' | null;
  /** The shell has an icon in the menu bar or system tray. */
  tray: boolean;
  doc: DesktopDoc;
  saving: boolean;
  /** Every project on the list, most recently opened first. Each is scanned only when something shows it. */
  projects: ProjectState[];
  recents: RecentItem[];
  recovery: RecoveryEntry[];
  settings: DesktopSettings;
  settingsOpen: boolean;
  renameTarget: RenameTarget | null;
  /** Where an update stands, as the shell last said. Null until it has. */
  update: UpdateSnapshot | null;
  /** The update panel is open. */
  updateOpen: boolean;
  /** Agent access as the shell last described it; null until Settings has asked. */
  agent: AgentSettings | null;
}

const INITIAL: DesktopState = {
  ready: false,
  listed: false,
  platform: null,
  tray: false,
  doc: { kind: 'none' },
  saving: false,
  projects: [],
  recents: [],
  recovery: [],
  settings: { closeBehavior: 'ask', autoCheckUpdates: true },
  settingsOpen: false,
  renameTarget: null,
  update: null,
  updateOpen: false,
  agent: null,
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

