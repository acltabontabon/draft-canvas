/**
 * What the desktop shell (Rust) offers the app, one method per command. Nothing here imports Tauri:
 * the controller and its tests only ever see this interface, and `tauri/api.ts` is the one place
 * that turns each method into an `invoke`.
 *
 * The app never holds a file path it could hand back. Rust gives out opaque handles for the files
 * and folders the user picked, browsed in the explorer, or the OS opened, and only a handle is ever sent back — so a path
 * that didn't come from the user can't be read or written.
 */
import type { Snapshot as UpdateSnapshot, HostEvent as WireHostEvent } from './wire';
export type { UpdateInfo, Phase as UpdatePhase, Snapshot as UpdateSnapshot, MenuCommand } from './wire';
/** The agent context is refined by the bridge protocol beyond Rust's JSON value envelope. */
export type HostEvent = Exclude<WireHostEvent, { type: 'agent-request' }> | (Omit<Extract<WireHostEvent, { type: 'agent-request' }>, 'args' | 'context'> & { args: Record<string, unknown>; context: AgentContext });
import type { ExplorerStart, ExplorerDirectory, ExplorerLocation, ExplorerSaveResult, OpenedDoc, SavedAs, SaveResult, ProjectInfo, Scan as ProjectScan } from './wire';
export type { ExplorerSaveResult, ExplorerStart, ExplorerDirectory, ExplorerEntry, ExplorerLocation, ExplorerPlace, OpenedDoc, SavedAs, SaveResult, ProjectInfo, ProjectFile, Scan as ProjectScan } from './wire';

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

/** Where a canvas created inside a project (but never written to disk) remembers it should be saved. */
export interface StartLocation {
  projectHandle: Handle;
  relPath: string;
}

export interface RenamedFile {
  handle: Handle;
  name: string;
  displayPath: string;
}

export type StampCheck = 'unchanged' | 'changed' | 'missing';

export interface RecentItem {
  handle: Handle;
  kind: 'file' | 'project';
  name: string;
  displayPath: string;
  lastOpenedMs: number;
}

export type RecoveryOrigin =
  | { kind: 'quick' }
  /** `baseStamp`: the file's stamp when the snapshot's edits began — see `DesktopController.switchTo`. */
  | { kind: 'file'; name: string; displayPath: string; handle: Handle; baseStamp: string };

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
  /** Look for a newer version shortly after launch and once a day. Only ever looks. */
  autoCheckUpdates: boolean;
}

export interface HostBoot {
  /** The app's version, which is also the installer's. */
  version: string;
  platform: 'macos' | 'windows' | 'linux';
  settings: DesktopSettings;
  /** The project folders the person has added that are still there, most recently opened first. */
  projects: ProjectInfo[];
  /** The menu-bar or tray icon is up; some Linux desktops have nowhere to put one. */
  tray: boolean;
}

export type DocState =
  | { kind: 'none'; dirty: false }
  | { kind: 'quick'; dirty: boolean }
  | { kind: 'file'; dirty: boolean; name: string; handle: Handle };

/** What the shell tells the page about the diagram an agent's request names. */
export interface AgentContext {
  session?: string;
  diagramId?: string;
  project?: string;
  path?: string;
  open?: boolean;
  handle?: Handle;
  /** The file's text and stamp, when it isn't the open document. */
  text?: string;
  stamp?: string;
  /** For `open_created`: the new file's name and where it is. */
  name?: string;
  displayPath?: string;
  revision?: string;
}

/** Agent access as Settings shows it. Never the token. */
export interface AgentSettings {
  enabled: boolean;
  listening: boolean;
  connections: number;
  sidecarPath: string | null;
  sidecarWarning: string | null;
  /** `ready`: a hidden window keeps answering. `restart-needed`: after a restart it will (macOS 14+).
   *  `unverified`: this system offers no supported way to keep a hidden window running. */
  background: 'ready' | 'restart-needed' | 'unverified';
  projects: AgentProject[];
}

/** A listed folder, as Settings → AI agents shows it. */
export interface AgentProject {
  handle: Handle;
  name: string;
  displayPath: string;
  agent: boolean;
  /** The nearest other listed folder this one sits inside. A ticked one already reaches this one,
   *  since access is granted by path prefix. Absent from a shell older than the field. */
  within?: Handle | null;
}

/** A coding agent Settings can set up with one click (`src-tauri/src/agent/clients.rs`). */
export type AgentClient = 'codex' | 'claude-code' | 'gemini' | 'junie';

/** Where one agent's MCP configuration stands. */
export interface AgentClientSetup {
  client: AgentClient;
  /** `outdated`: it launches another copy of the connector (a moved or older app), or is turned off. */
  state: 'not-set-up' | 'ready' | 'outdated';
  /** Whether the shell can do the setup itself; false for Claude Code or Gemini CLI when its command can't be found. */
  automatic: boolean;
  /** The configuration file, written for a person. */
  location: string | null;
  /** What an outdated entry launches instead. */
  configuredCommand: string | null;
}

/** Where an agent skill is installed for every project (`src-tauri/src/agent/skill.rs`):
 *  `claude-code` is `~/.claude/skills`; `agents` is `~/.agents/skills`, which Codex, Cursor, Gemini CLI
 *  and Junie read. */
export type AgentSkillTarget = 'claude-code' | 'agents';

/** Where the Draft Canvas agent skill stands in one target. */
export interface AgentSkillSetup {
  target: AgentSkillTarget;
  /** `outdated`: an older copy this app wrote, untouched (replaced at launch). `modified`: changed
   *  since, or put there by someone else (left alone). `newer`: written by a newer Draft Canvas. */
  state: 'not-installed' | 'ready' | 'outdated' | 'modified' | 'newer';
  /** The skill's folder, written for a person. */
  location: string | null;
  installedVersion: string | null;
  bundledVersion: string;
  /** Where an edited copy was kept by the last install or removal. */
  backup: string | null;
}

export interface AgentPatch {
  enabled?: boolean;
  project?: { handle: Handle; agent: boolean };
  rotate?: boolean;
}

/** A batch of changes a coding agent submitted for a person to explicitly accept or reject — never
 *  applied by `submit_proposal` itself. See `src-tauri/src/agent/proposals.rs`. */
export interface Proposal {
  proposalId: string;
  /** Bumped on every revise-in-place; the review panel must re-check this hasn't moved on since it
   *  loaded the proposal, immediately before accepting. */
  version: number;
  diagramId: string;
  path: string[];
  status: 'pending' | 'accepting' | 'accepted' | 'rejected' | 'dismissed' | 'informational' | 'accept-failed';
  baseRevision: string;
  ops: unknown[];
  layout: unknown;
  preconditions: import('../agent/proposal').PreconditionSnapshot;
  scope?: unknown;
  counts: { added: number; updated: number; removed: number; arranged?: number };
  summary: string;
  rationale: string;
  assumptions: string[];
  openQuestions: string[];
  sourceRef: { url?: string; title?: string; baseCommit?: string; headCommit?: string } | null;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
  /** `baseRevision` no longer matches the diagram's current revision — informational only; the
   *  review panel always re-diffs against the live document rather than trusting this. */
  stale: boolean;
}

/** What `agentProposalBeginAccept`/`agentProposalResolve` answer — a business outcome, not a thrown
 *  error, since "already resolved" or "wrong stage" are expected, not exceptional. */
export type ProposalAction =
  | { ok: true; proposal: Proposal }
  | { ok: false; code: 'NOT_FOUND' }
  | { ok: false; code: 'WRONG_STAGE'; status: Proposal['status'] }
  | { ok: false; code: 'PROPOSAL_CHANGED'; proposal: Proposal }
  | { ok: false; code: 'ALREADY_RESOLVED'; status: Proposal['status'] };

export type QuitDecision = 'working' | 'ready' | 'prompting' | 'cancel';

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
  saveAs(suggestedName: string, bytes: Uint8Array, copySidecarFrom?: Handle, startIn?: StartLocation): Promise<SavedAs | null>;
  /** "Rename file…": changes the file's name in place. Never touches the document's own title. */
  renameFile(handle: Handle, newStem: string): Promise<RenamedFile>;
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

  // Projects: folders the user picked, kept on a list until they let one go
  /** Picks a folder and adds it to the front of the project list. */
  pickProject(): Promise<ProjectInfo | null>;
  /** Moves a project to the front of the list. */
  openProject(handle: Handle): Promise<ProjectInfo>;
  /** Takes a project off the list; the folder and its files are left as they are. */
  projectForget(handle: Handle): Promise<void>;
  projectScan(handle: Handle): Promise<ProjectScan>;
  projectOpenFile(projectHandle: Handle, relPath: string): Promise<OpenedDoc>;
  /** `peekDocument`, for a file in the open project. */
  projectPeek(projectHandle: Handle, relPath: string): Promise<string | null>;
  /** A handle for a file in a project's scan, without opening it — what renaming a file Find a Diagram
   * has only ever listed (never opened) needs. */
  projectGrantFile(projectHandle: Handle, relPath: string): Promise<Handle>;
  projectSaveNew(projectHandle: Handle, name: string, bytes: Uint8Array): Promise<SavedAs>;

  // Temporary explorer sessions. Browsing never adds a project or recent file.
  explorerOpen(startIn?: StartLocation): Promise<ExplorerStart>;
  explorerList(session: string, handle: Handle, showHidden: boolean, query: string, offset: number): Promise<ExplorerDirectory>;
  explorerSaveFile(session: string, handle: Handle, name: string, bytes: Uint8Array, copySidecarFrom?: Handle, expectedStamp?: string): Promise<ExplorerSaveResult>;
  explorerCreateFolder(session: string, handle: Handle, name: string): Promise<ExplorerLocation>;
  explorerPeek(session: string, handle: Handle): Promise<string | null>;
  explorerAddProject(session: string, handle: Handle): Promise<ProjectInfo>;
  explorerOpenFile(session: string, handle: Handle): Promise<OpenedDoc>;
  explorerClose(session: string): Promise<void>;

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

  // Updates. Each returns the whole snapshot; the same arrives as an `update` event on every change.
  updateStatus(): Promise<UpdateSnapshot>;
  /** `manual` when a person asked: only then is a failure worth showing. */
  updateCheck(manual: boolean): Promise<UpdateSnapshot>;
  updateDownload(): Promise<UpdateSnapshot>;
  /** Asks the quit question first; when it works the app is replaced and relaunched. */
  updateInstall(): Promise<UpdateSnapshot>;
  updateDismiss(): Promise<UpdateSnapshot>;

  // AI agents (see `agent-request`)
  agentAck(id: number): Promise<void>;
  /** True: go ahead and change the document. False: the request expired or was cancelled — change nothing. */
  agentGate(id: number): Promise<boolean>;
  /** The person cancelled it. True if it was still before its gate (it will now change nothing). */
  agentCancel(id: number): Promise<boolean>;
  /** A short stage phrase for the agent that sent request `id` (MCP progress, if its client asked). */
  agentProgress(id: number, message: string): Promise<void>;
  agentRespond(id: number, outcome: unknown): Promise<void>;
  agentStatus(): Promise<AgentSettings>;
  agentConfigure(patch: AgentPatch): Promise<AgentSettings>;
  /** Whether each agent Settings can set up launches this app's connector. Empty without a connector. */
  agentClients(): Promise<AgentClientSetup[]>;
  /** Adds Draft Canvas to an agent's MCP configuration, or repoints the entry already there. */
  agentConnectClient(client: AgentClient): Promise<AgentClientSetup>;
  /** Where the agent skill stands in each place agents read skills from. */
  agentSkills(): Promise<AgentSkillSetup[]>;
  /** Installs (or updates, or replaces) the agent skill; an edited copy is kept as a backup. */
  agentInstallSkill(target: AgentSkillTarget): Promise<AgentSkillSetup>;
  agentRemoveSkill(target: AgentSkillTarget): Promise<AgentSkillSetup>;

  // Proposal review (native UI only — see `agent/proposals.rs`; never reachable from the MCP bridge)
  agentProposalList(diagramId?: string): Promise<Proposal[]>;
  agentProposalGet(id: string): Promise<Proposal | null>;
  /** Durably records `pending → accepting` before the document commit is attempted. */
  agentProposalBeginAccept(id: string, version: number, diagramId: string, path: string[]): Promise<ProposalAction>;
  agentProposalResolve(id: string, status: 'accepted' | 'rejected' | 'dismissed'): Promise<ProposalAction>;
}
