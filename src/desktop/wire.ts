// Generated from Rust by npm run desktop:bindings. Do not edit.
export type OpenedDoc = { handle: string, name: string, displayPath: string, text: string, stamp: string, readOnly: boolean, };
export type SavedAs = { handle: string, name: string, displayPath: string, stamp: string, };
export type SaveResult = { "outcome": "saved", stamp: string, } | { "outcome": "conflict" };
export type ProjectInfo = { handle: string, name: string, displayPath: string, };
export type ProjectFile = {
/**
 * Relative to the project, `/`-separated on every OS.
 */
relPath: string,
/**
 * The file name without `.draftcanvas`.
 */
name: string, mtimeMs: number, size: number, };
export type Scan = { files: Array<ProjectFile>,
/**
 * The `rel_path` (project-relative, `/`-separated) of every folder whose contents weren't fully
 * listed because a limit was hit — the root itself is `""`. Empty when nothing was cut off.
 */
truncatedDirs: Array<string>, };
export type ExplorerKind = "folder" | "file";
export type ExplorerLocation = { handle: string, name: string, displayPath: string, };
export type ExplorerPlace = { location: ExplorerLocation, project: boolean, };
export type ExplorerEntry = { handle: string, name: string, kind: ExplorerKind, displayPath: string, size: number | null, modifiedMs: number, };
export type ExplorerDirectory = { location: ExplorerLocation, breadcrumbs: Array<ExplorerLocation>, entries: Array<ExplorerEntry>, total: number, nextOffset: number | null, truncated: boolean, };
export type ExplorerStart = { session: string, places: Array<ExplorerPlace>, directory: ExplorerDirectory, };
export type ExplorerSaveResult = { "outcome": "saved", saved: SavedAs, } | { "outcome": "exists", name: string, stamp: string, };
export type UpdateInfo = { version: string,
/**
 * The release's section of the changelog.
 */
notes: string | null, };
export type Phase = { "phase": "idle" } | { "phase": "checking" } | { "phase": "up-to-date", checkedMs: number, } | { "phase": "available", info: UpdateInfo, } | { "phase": "downloading", info: UpdateInfo, received: number,
/**
 * `None` when the server didn't say: the page shows movement, not a percentage that lies.
 */
total: number | null, } | { "phase": "ready", info: UpdateInfo, } | { "phase": "installing", info: UpdateInfo, } | { "phase": "unavailable", reason: string, };
export type Stage = "check" | "download" | "install";
export type Failure = { stage: Stage, message: string,
/**
 * A person asked for this. A background check that fails isn't worth interrupting anyone for.
 */
manual: boolean, };
export type Snapshot = { currentVersion: string, state: Phase,
/**
 * The person said "Later" to the version in `state` during this run.
 */
dismissed: boolean,
/**
 * Why the last install didn't go ahead (they chose to keep working), if it just happened.
 */
held: string | null, error: Failure | null, };
export type MenuCommand = "save" | "save-as" | "open" | "open-project" | "new-canvas" | "reveal" | "revert" | "rename" | "settings" | "about" | "shortcuts" | "undo" | "redo" | "select-all";
export type HostEvent = { "type": "open", handle: string, name: string, displayPath: string, } | { "type": "new-quick-draft" } | { "type": "menu", command: MenuCommand, } | { "type": "quit-requested" } | { "type": "update-requested" } | { "type": "update", snapshot: Snapshot, } | { "type": "window-focused" } | { "type": "disk-changed" } | { "type": "recents-changed" } | { "type": "notice", message: string, } | { "type": "agent-request", id: number, tool: string, args: unknown, context: unknown, } | { "type": "agent-file-written", id: number, handle: string | null, displayPath: string, stamp: string,
/**
 * A new diagram (nothing to undo); otherwise a change to an existing one.
 */
created: boolean, } | { "type": "agent-changed" };
