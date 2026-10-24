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
export type MenuCommand = "save" | "save-as" | "open" | "open-project" | "new-canvas" | "reveal" | "revert" | "rename" | "settings" | "about" | "shortcuts" | "undo" | "redo" | "select-all" | "canvas-settings" | "find-replace" | "commands" | "arrange";
export type HostEvent = { "type": "open", handle: string, name: string, displayPath: string, } | { "type": "new-quick-draft" } | { "type": "menu", command: MenuCommand, } | { "type": "quit-requested" } | { "type": "update-requested" } | { "type": "update", snapshot: Snapshot, } | { "type": "window-focused" } | { "type": "disk-changed" } | { "type": "recents-changed" } | { "type": "notice", message: string, } | { "type": "agent-request", id: number, tool: string, args: unknown, context: unknown, } | { "type": "agent-file-written", id: number, handle: string | null, displayPath: string, stamp: string,
/**
 * A new diagram (nothing to undo); otherwise a change to an existing one.
 */
created: boolean, } | { "type": "agent-changed" } | { "type": "companion", run: string, event: RunEvent, } | { "type": "collab-lan-open", connId: string, } | { "type": "collab-lan-message", connId: string, text: string, } | { "type": "collab-lan-close", connId: string, reason: string, } | { "type": "collab-lan-stopped", reason: string, token: string, };
export type CollabLanStarted = { port: number, addresses: Array<string>, };
export type AgentKind = "claude-code" | "codex";
export type Selection = { nodes: Array<string>, edges: Array<string>, };
export type ApplyMode = "proposal" | "direct";
export type PromptRequest = {
/**
 * Made by the page, so events that arrive before `companion_send` returns are already its.
 */
runId: string, diagramId: string,
/**
 * The person's words, passed on unchanged.
 */
text: string, selection: Selection | null,
/**
 * The room the person is in, outermost first; empty at the root.
 */
room: Array<string>, agent: AgentKind, mode: ApplyMode,
/**
 * The page's word that the diagram is as it was when this conversation's last turn was sent,
 * so the agent can skip reading it again (a read is a round trip, and its whole answer). False
 * whenever the page can't be sure.
 */
unchanged?: boolean,
/**
 * The view as read_diagram would answer it, read by the page as the turn was sent, so the agent's
 * first call needn't be a read. JSON text; left out when it was too big or couldn't be read.
 */
snapshot?: string, };
export type ToolStatus = "in-progress" | "completed" | "failed";
export type StopReason = { "kind": "end-turn" } | { "kind": "cancelled" } | { "kind": "max-turns" } | { "kind": "refusal" } | { "kind": "failed", message: string, };
export type Usage = { input: number, cached: number, output: number, };
export type RunEvent = { "type": "started", session: string, } | { "type": "message-chunk", text: string, } | { "type": "tool-call", id: string, tool: string, status: ToolStatus, } | { "type": "tool-call-update", id: string, status: ToolStatus, error: string | null, } | { "type": "stopped", reason: StopReason, summary: string | null,
/**
 * What the turn cost in millionths of a dollar, as the agent reported it.
 */
costMicroUsd: number | null,
/**
 * The tokens the turn used, as the agent reported them.
 */
usage: Usage | null, };
export type Availability = "installed" | "missing" | "too-old";
export type SignIn = { loggedIn: boolean | null,
/**
 * The agent's own word for how it signs in (`claude.ai`, `api_key`, …).
 */
method: string | null,
/**
 * Where the agent keeps its transcripts, for the person to see.
 */
transcripts: string | null, };
export type AgentInfo = { agent: AgentKind,
/**
 * How the companion names it: the page has no list of agents of its own.
 */
name: string, availability: Availability, version: string | null, signIn: SignIn, };
export type RunSnapshot = { runId: string, diagramId: string, agent: AgentKind,
/**
 * What the person typed.
 */
prompt: string, events: Array<RunEvent>, };
