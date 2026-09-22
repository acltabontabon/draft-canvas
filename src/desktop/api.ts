/**
 * What the desktop shell (Rust) offers the app, one method per command. Nothing here imports Tauri:
 * the controller and its tests only ever see this interface, and `tauri/api.ts` is the one place
 * that turns each method into an `invoke`.
 *
 * The app never holds a file path it could hand back. Rust gives out opaque handles for the files
 * and folders the user picked (or the OS opened), and only a handle is ever sent back — so a path
 * that didn't come from the user can't be read or written.
 */
export type Handle = string;

export type AppErrorKind =
  | 'NotFound'
  | 'PermissionDenied'
  | 'ReadOnly'
  | 'DiskFull'
  | 'TooLarge'
  | 'NotADocument'
  | 'InvalidHandle'
  | 'InvalidPath'
  | 'AlreadyExists'
  | 'Io';

/** A refusal from the shell, already worded for a person ("…because the file is read-only."). */
export class DesktopError extends Error {
  readonly kind: AppErrorKind;
  readonly path: string | undefined;

  constructor(kind: AppErrorKind, message: string, path?: string) {
    super(message);
    this.name = 'DesktopError';
    this.kind = kind;
    this.path = path;
  }
}

export interface OpenedDoc {
  handle: Handle;
  /** The file's name without its extension. */
  name: string;
  /** Where it lives, written for display (`~/work/payment-flow.draftcanvas`). */
  displayPath: string;
  text: string;
  /** Opaque: pass it back with the next save so a change made outside the app is noticed. */
  stamp: string;
  readOnly: boolean;
}

export type SaveResult = { outcome: 'saved'; stamp: string } | { outcome: 'conflict' };

export interface SavedAs {
  handle: Handle;
  name: string;
  displayPath: string;
  stamp: string;
}

export type StampCheck = 'unchanged' | 'changed' | 'missing';

export interface ProjectInfo {
  handle: Handle;
  name: string;
  displayPath: string;
}

export interface ProjectFile {
  /** Relative to the project, always with `/`. */
  relPath: string;
  name: string;
  mtimeMs: number;
  size: number;
}

export interface ProjectScan {
  files: ProjectFile[];
  /** The folder held more than the scan is willing to list. */
  truncated: boolean;
}

export interface RecentItem {
  handle: Handle;
  kind: 'file' | 'project';
  name: string;
  displayPath: string;
  lastOpenedMs: number;
}

export type RecoveryOrigin = { kind: 'quick' } | { kind: 'file'; name: string; displayPath: string; handle: Handle };

export interface RecoveryEntry {
  id: string;
  origin: RecoveryOrigin;
  title: string;
  updatedAt: number;
  bytes: number;
}

export type CloseBehavior = 'ask' | 'tray' | 'quit';

export interface DesktopSettings {
  closeBehavior: CloseBehavior;
}

export interface HostBoot {
  /** The app's version, which is also the installer's. */
  version: string;
  platform: 'macos' | 'windows' | 'linux';
  settings: DesktopSettings;
  /** The folder the last session had open, if it is still there. Nothing is opened from it on its own. */
  lastProject: ProjectInfo | null;
}

export type DocState =
  | { kind: 'none'; dirty: false }
  | { kind: 'quick'; dirty: boolean }
  | { kind: 'file'; dirty: boolean; name: string; handle: Handle };

export type MenuCommand =
  | 'save'
  | 'save-as'
  | 'open'
  | 'open-project'
  | 'new-canvas'
  | 'reveal'
  | 'revert'
  | 'settings'
  | 'about'
  | 'shortcuts'
  | 'undo'
  | 'redo'
  | 'select-all';

/** What the shell tells the app on its own account: a menu pick, a file the OS opened, the app being asked to quit. */
export type HostEvent =
  | { type: 'open'; handle: Handle; name: string; displayPath: string }
  | { type: 'new-quick-draft' }
  | { type: 'new-canvas' }
  /** A draft chosen from the tray's Unsaved section. */
  | { type: 'recover-draft'; id: string }
  | { type: 'menu'; command: MenuCommand }
  | { type: 'quit-requested' }
  | { type: 'window-focused' }
  | { type: 'recents-changed' }
  | { type: 'notice'; message: string };

export type QuitDecision = 'ready' | 'prompting' | 'cancel';

/**
 * What the page draws for the tray menu, as base64 PNGs: the action icons, each recent file's
 * silhouette and each unsaved draft's, in the ink of the current appearance. Files go by handle,
 * drafts by recovery id — nothing here names a path.
 */
export interface TrayArt {
  actions: Partial<Record<'quickDraft' | 'newCanvas' | 'open' | 'openProject', string>>;
  files: { handle: Handle; png: string }[];
  drafts: { id: string; title: string; png?: string }[];
}

export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface DesktopApi {
  // Lifecycle
  hostReady(onEvent: (event: HostEvent) => void): Promise<HostBoot>;
  reportState(state: DocState): Promise<void>;
  quitAck(decision: QuitDecision): Promise<void>;
  quitNow(): Promise<void>;

  // Documents. `null` is the user cancelling a dialog, never an error.
  openDialog(): Promise<OpenedDoc | null>;
  openHandle(handle: Handle): Promise<OpenedDoc>;
  saveDocument(handle: Handle, bytes: Uint8Array, expectedStamp: string | undefined): Promise<SaveResult>;
  saveAs(suggestedName: string, bytes: Uint8Array, copySidecarFrom?: Handle): Promise<SavedAs | null>;
  checkStamp(handle: Handle, stamp: string): Promise<StampCheck>;
  reveal(handle: Handle): Promise<void>;
  exportFile(name: string, filters: FileFilter[], bytes: Uint8Array): Promise<boolean>;
  openExternal(url: string): Promise<void>;
  sidecarRead(handle: Handle): Promise<{ mime: string; base64: string } | null>;
  sidecarWrite(handle: Handle, mime: string, base64: string): Promise<void>;
  sidecarRemove(handle: Handle): Promise<void>;
  /**
   * A file's text for Home to draw its thumbnail from — looking, not opening: nothing goes into
   * Recent. `null` when it can't be looked at (gone, unreadable, too large for a thumbnail).
   */
  peekDocument(handle: Handle): Promise<string | null>;

  // Projects: a folder the user picked
  pickProject(): Promise<ProjectInfo | null>;
  openProject(handle: Handle): Promise<ProjectInfo>;
  projectScan(handle: Handle): Promise<ProjectScan>;
  projectOpenFile(projectHandle: Handle, relPath: string): Promise<OpenedDoc>;
  /** `peekDocument`, for a file in the open project. */
  projectPeek(projectHandle: Handle, relPath: string): Promise<string | null>;
  projectSaveNew(projectHandle: Handle, name: string, bytes: Uint8Array): Promise<SavedAs>;

  // Recents
  recentsList(): Promise<RecentItem[]>;
  recentsRemove(handle: Handle): Promise<void>;
  recentsClear(): Promise<void>;

  // Recovery: working copies kept in the app's own data folder, never in the user's files
  recoveryWrite(
    id: string,
    origin: { kind: 'quick' } | { kind: 'file'; handle: Handle; baseStamp: string },
    title: string,
    bytes: Uint8Array,
  ): Promise<void>;
  recoveryList(): Promise<RecoveryEntry[]>;
  recoveryRead(id: string): Promise<string>;
  recoveryDiscard(id: string): Promise<void>;

  // Settings and dialogs
  settingsGet(): Promise<DesktopSettings>;
  settingsSet(patch: Partial<DesktopSettings>): Promise<DesktopSettings>;
  /**
   * A native message box with one to three buttons; resolves to the index of the one pressed. Closing
   * the box any other way is the last button, so that is always the one that changes nothing.
   */
  ask(title: string, message: string, buttons: string[]): Promise<number>;
  showError(title: string, message: string): Promise<void>;

  // The tray
  trayDecorate(art: TrayArt): Promise<void>;
}
