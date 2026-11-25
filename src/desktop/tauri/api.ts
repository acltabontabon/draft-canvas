import { Channel, invoke } from '@tauri-apps/api/core';
import {
  DesktopError,
  type AgentInfo,
  type CodeFolder,
  type AgentClientSetup,
  type AgentSkillSetup,
  type AgentSettings,
  type AppErrorKind,
  type CollabLanStarted,
  type DesktopApi,
  type DesktopSettings,
  type HostBoot,
  type Proposal,
  type ProposalAction,
  type RunSnapshot,
  type UpdateSnapshot,
  type HostEvent,
} from '../api';

/**
 * The only place the app calls into Tauri. Every method is one command of the shell, with the same
 * name and shape (`src-tauri/src/commands.rs`); nothing here decides anything.
 */

interface AppErrorPayload {
  kind: AppErrorKind;
  message: string;
  path?: string;
  reason?: string;
}

function isAppError(value: unknown): value is AppErrorPayload {
  return typeof value === 'object' && value !== null && 'kind' in value && 'message' in value;
}

function asDesktopError(error: unknown): DesktopError {
  if (isAppError(error)) return new DesktopError(error.kind, error.message, error.path, error.reason);
  return new DesktopError('Io', typeof error === 'string' && error ? error : 'Something unexpected went wrong.');
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw asDesktopError(error);
  }
}

/**
 * A command whose payload is the document (or an image) itself, sent as raw bytes rather than
 * escaped into JSON — a large diagram is tens of megabytes. Its other arguments travel as JSON in a header.
 */
async function callRaw<T>(command: string, meta: Record<string, unknown>, bytes: Uint8Array): Promise<T> {
  try {
    return await invoke<T>(command, bytes, { headers: { 'x-meta': encodeURIComponent(JSON.stringify(meta)) } });
  } catch (error) {
    throw asDesktopError(error);
  }
}

/** A guest's message goes as raw UTF-8 (`callRaw`): a whole diagram is megabytes of JSON already. */
const utf8 = new TextEncoder();

export function createTauriApi(): DesktopApi {
  return {
    async hostReady(onEvent) {
      const events = new Channel<HostEvent>();
      events.onmessage = onEvent;
      return call<HostBoot>('host_ready', { onEvent: events });
    },
    reportState: (state) => call('report_state', { state }),
    quitAck: (decision) => call('quit_ack', { decision }),

    openHandle: (handle) => call('open_handle', { handle }),
    saveDocument: (handle, bytes, expectedStamp) => callRaw('save_document', { handle, expectedStamp }, bytes),
    saveAs: (suggestedName, bytes, startIn) => callRaw('save_as', { suggestedName, startIn }, bytes),
    renameFile: (handle, newStem) => call('rename_file', { handle, newStem }),
    checkStamp: (handle, stamp) => call('check_stamp', { handle, stamp }),
    reveal: (handle) => call('reveal', { handle }),
    exportFile: (name, filters, bytes) => callRaw('export_file', { name, filters }, bytes),
    openExternal: (url) => call('open_external', { url }),
    docsStatus: (handle, withSvg) => call('docs_status', { handle, withSvg: withSvg ?? false }),
    docsPublish: (handle, name, svg, fresh) => callRaw('docs_publish', { handle, name, fresh: fresh ?? false }, new TextEncoder().encode(svg)),
    docsPickMarkdown: (handle) => call('docs_pick_markdown', { handle }),
    docsAddToMarkdown: (markdown, text, expectedStamp) => callRaw('docs_add_to_markdown', { markdown, expectedStamp }, new TextEncoder().encode(text)),
    docsReveal: (handle, name) => call('docs_reveal', { handle, name }),
    peekDocument: (handle) => call('peek_document', { handle }),

    pickProject: () => call('pick_project'),
    openProject: (handle) => call('open_project', { handle }),
    projectScan: (handle) => call('project_scan', { handle }),
    projectOpenFile: (projectHandle, relPath) => call('project_open_file', { projectHandle, relPath }),
    projectPeek: (projectHandle, relPath) => call('project_peek', { projectHandle, relPath }),
    projectGrantFile: (projectHandle, relPath) => call('project_grant_file', { projectHandle, relPath }),
    projectForget: (handle) => call('project_forget', { handle }),
    projectSaveNew: (projectHandle, name, bytes) => callRaw('project_save_new', { projectHandle, name }, bytes),
    projectMoveFile: (handle, projectHandle, keepBoth) => call('project_move_file', { handle, projectHandle, keepBoth }),

    explorerOpen: (startIn) => call('explorer_open', { startIn }),
    explorerList: (session, handle, showHidden, query, offset) => call('explorer_list', { session, handle, showHidden, query, offset }),
    explorerSaveFile: (session, handle, name, bytes, expectedStamp) => callRaw('explorer_save_file', { session, handle, name, expectedStamp }, bytes),
    explorerCreateFolder: (session, handle, name) => call('explorer_create_folder', { session, handle, name }),
    explorerPeek: (session, handle) => call('explorer_peek', { session, handle }),
    explorerAddProject: (session, handle) => call('explorer_add_project', { session, handle }),
    explorerOpenFile: (session, handle) => call('explorer_open_file', { session, handle }),
    explorerClose: (session) => call('explorer_close', { session }),

    recentsList: () => call('recents_list'),
    recentsRemove: (handle) => call('recents_remove', { handle }),
    recentsClear: () => call('recents_clear'),

    recoveryWrite: (id, origin, title, bytes) => callRaw('recovery_write', { id, origin, title }, bytes),
    recoveryList: () => call('recovery_list'),
    async recoveryRead(id) {
      return (await call<{ text: string }>('recovery_read', { id })).text;
    },
    recoveryDiscard: (id) => call('recovery_discard', { id }),

    historyList: () => call('history_list'),
    historyCreate: (meta) => call('history_create', { meta }),
    historyRemove: (repo) => call('history_remove', { repo }),
    historyMeta: (repo) => call('history_meta', { repo }),
    historyWriteMeta: (repo, meta) => call('history_write_meta', { repo, meta }),
    historyWriteSnapshot: (repo, { text, ...head }) => callRaw('history_write_snapshot', { repo, ...head }, utf8.encode(text)),
    historyUpdateRef: (repo, update) => call('history_update_ref', { repo, update }),
    historyReadRef: (repo, name) => call('history_read_ref', { repo, name }),
    historyListRefs: (repo, prefix) => call('history_list_refs', { repo, prefix }),
    historyReadCommits: (repo, oids) => call('history_read_commits', { repo, oids }),
    // Raw bytes back (a diagram is megabytes); the shell has already checked they are UTF-8.
    async historyReadSnapshot(repo, oid) {
      return new TextDecoder('utf-8', { fatal: true }).decode(await call<ArrayBuffer>('history_read_snapshot', { repo, oid }));
    },
    historyLog: (repo, query) => call('history_log', { repo, query }),
    historyMergeBases: (repo, a, b) => call('history_merge_bases', { repo, a, b }),
    historyIsAncestor: (repo, ancestor, descendant) => call('history_is_ancestor', { repo, ancestor, descendant }),
    historyWriteTag: (repo, tag) => call('history_write_tag', { repo, tag }),
    historyListTags: (repo, prefix) => call('history_list_tags', { repo, prefix }),
    historyJournalPut: (repo, record) => call('history_journal_put', { repo, record }),
    historyJournalList: (repo) => call('history_journal_list', { repo }),
    historyJournalDelete: (repo, opId) => call('history_journal_delete', { repo, opId }),
    historyUsage: (repo) => call('history_usage', { repo }),
    historyMaintain: (repo) => call('history_maintain', { repo }),
    async historyPackReachable(repo, tips) {
      return new Uint8Array(await call<ArrayBuffer>('history_pack_reachable', { repo, tips }));
    },
    historyImportBegin: (meta, pack) => callRaw('history_import_begin', { meta }, pack),
    historyImportCommit: (staging, refs) => call('history_import_commit', { staging, refs }),
    historyImportAbort: (staging) => call('history_import_abort', { staging }),
    historyBindingGet: (copyId) => call('history_binding_get', { copyId }),
    historyBindingPut: (binding) => call('history_binding_put', { binding }),
    historyBindingDelete: (copyId) => call('history_binding_delete', { copyId }),
    historyBindingList: () => call('history_binding_list'),
    historyGitStatus: () => call('history_git_status'),
    historyRemoteSet: (repo, url) => call('history_remote_set', { repo, url }),
    historyRemoteRemove: (repo) => call('history_remote_remove', { repo }),
    historyFetch: (repo) => call('history_fetch', { repo }),
    historyPushPreview: (repo, refs) => call('history_push_preview', { repo, refs }),
    historyPush: (repo, refs) => call('history_push', { repo, refs }),
    historyProjectRepo: (handle) => call('history_project_repo', { handle }),
    historyProjectPublishBranch: (handle, message) => call('history_project_publish_branch', { handle, message }),
    historyProjectCommitCurrent: (handle, message, expectedHead) => call('history_project_commit_current', { handle, message, expectedHead }),
    historyProjectPushPreview: (handle, branch) => call('history_project_push_preview', { handle, branch }),
    historyProjectPush: (handle, branch) => call('history_project_push', { handle, branch }),

    settingsSet: (patch) => call<DesktopSettings>('settings_set', { patch }),
    ask: (title, message, buttons) => call('ask', { title, message, buttons }),
    showError: (title, message) => call('show_error', { title, message }),
    updateStatus: () => call<UpdateSnapshot>('update_status'),
    updateCheck: (manual) => call<UpdateSnapshot>('update_check', { manual }),
    updateDownload: () => call<UpdateSnapshot>('update_download'),
    updateInstall: () => call<UpdateSnapshot>('update_install'),
    updateDismiss: () => call<UpdateSnapshot>('update_dismiss'),
    agentAck: (id) => call<void>('agent_ack', { id }),
    agentGate: (id) => call<boolean>('agent_gate', { id }),
    agentCancel: (id) => call<boolean>('agent_cancel', { id }),
    agentProgress: (id, message) => call<void>('agent_progress', { id, message }),
    agentRespond: (id, outcome) => call<void>('agent_respond', { id, outcome }),
    agentStatus: () => call<AgentSettings>('agent_status'),
    agentConfigure: (patch) => call<AgentSettings>('agent_configure', { patch }),
    agentClients: () => call<AgentClientSetup[]>('agent_clients'),
    agentConnectClient: (client) => call<AgentClientSetup>('agent_connect_client', { client }),
    agentSkills: () => call<AgentSkillSetup[]>('agent_skills'),
    agentInstallSkill: (target) => call<AgentSkillSetup>('agent_install_skill', { target }),
    agentRemoveSkill: (target) => call<AgentSkillSetup>('agent_remove_skill', { target }),
    agentProposalList: (diagramId) => call<Proposal[]>('agent_proposal_list', { diagramId }),
    agentProposalGet: (id) => call<Proposal | null>('agent_proposal_get', { id }),
    agentProposalBeginAccept: (id, version, diagramId, path) => call<ProposalAction>('agent_proposal_begin_accept', { id, version, diagramId, path }),
    agentProposalResolve: (id, status) => call<ProposalAction>('agent_proposal_resolve', { id, status }),
    companionAgents: () => call<AgentInfo[]>('companion_agents'),
    companionSend: (request) => call<void>('companion_send', { request }),
    companionCancel: (runId) => call<boolean>('companion_cancel', { runId }),
    companionRuns: () => call<RunSnapshot[]>('companion_runs'),
    companionForget: (diagramId, agent) => call<void>('companion_forget', { diagramId, agent }),
    companionCode: (diagramId) => call<CodeFolder>('companion_code', { diagramId }),
    companionAllowCode: (diagramId, grant) => call<CodeFolder>('companion_allow_code', { diagramId, grant }),
    companionChooseCode: (diagramId) => call<CodeFolder | null>('companion_choose_code', { diagramId }),
    companionContinue: (diagramId, agent) => call<string | null>('companion_continue', { diagramId, agent }),

    collabLanStart: ({ token }) => call<CollabLanStarted>('collab_lan_start', { token }),
    collabLanStop: (options) => call<void>('collab_lan_stop', options ? { token: options.token } : {}),
    collabLanSend: (connId, text, options) => callRaw<void>('collab_lan_send', options?.presence ? { connId, presence: true } : { connId }, utf8.encode(text)),
    collabLanClose: (connId, reason) => call<void>('collab_lan_close', { connId, reason }),
  };
}
