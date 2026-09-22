import { Channel, invoke } from '@tauri-apps/api/core';
import {
  DesktopError,
  type AppErrorKind,
  type DesktopApi,
  type DesktopSettings,
  type HostBoot,
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
}

function isAppError(value: unknown): value is AppErrorPayload {
  return typeof value === 'object' && value !== null && 'kind' in value && 'message' in value;
}

function asDesktopError(error: unknown): DesktopError {
  if (isAppError(error)) return new DesktopError(error.kind, error.message, error.path);
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

export function createTauriApi(): DesktopApi {
  return {
    async hostReady(onEvent) {
      const events = new Channel<HostEvent>();
      events.onmessage = onEvent;
      return call<HostBoot>('host_ready', { onEvent: events });
    },
    reportState: (state) => call('report_state', { state }),
    quitAck: (decision) => call('quit_ack', { decision }),
    quitNow: () => call('quit_now'),

    openDialog: () => call('open_dialog'),
    openHandle: (handle) => call('open_handle', { handle }),
    saveDocument: (handle, bytes, expectedStamp) => callRaw('save_document', { handle, expectedStamp }, bytes),
    saveAs: (suggestedName, bytes, copySidecarFrom, startIn) =>
      callRaw('save_as', { suggestedName, copySidecarFrom, startIn }, bytes),
    renameFile: (handle, newStem) => call('rename_file', { handle, newStem }),
    checkStamp: (handle, stamp) => call('check_stamp', { handle, stamp }),
    reveal: (handle) => call('reveal', { handle }),
    exportFile: (name, filters, bytes) => callRaw('export_file', { name, filters }, bytes),
    openExternal: (url) => call('open_external', { url }),
    sidecarRead: (handle) => call('sidecar_read', { handle }),
    sidecarWrite: (handle, mime, base64) => call('sidecar_write', { handle, mime, base64 }),
    sidecarRemove: (handle) => call('sidecar_remove', { handle }),
    peekDocument: (handle) => call('peek_document', { handle }),

    pickProject: () => call('pick_project'),
    openProject: (handle) => call('open_project', { handle }),
    projectScan: (handle) => call('project_scan', { handle }),
    projectOpenFile: (projectHandle, relPath) => call('project_open_file', { projectHandle, relPath }),
    projectPeek: (projectHandle, relPath) => call('project_peek', { projectHandle, relPath }),
    projectGrantFile: (projectHandle, relPath) => call('project_grant_file', { projectHandle, relPath }),
    projectForget: (handle) => call('project_forget', { handle }),
    projectSaveNew: (projectHandle, name, bytes) => callRaw('project_save_new', { projectHandle, name }, bytes),

    recentsList: () => call('recents_list'),
    recentsRemove: (handle) => call('recents_remove', { handle }),
    recentsClear: () => call('recents_clear'),

    recoveryWrite: (id, origin, title, bytes) => callRaw('recovery_write', { id, origin, title }, bytes),
    recoveryList: () => call('recovery_list'),
    async recoveryRead(id) {
      return (await call<{ text: string }>('recovery_read', { id })).text;
    },
    recoveryDiscard: (id) => call('recovery_discard', { id }),

    settingsGet: () => call<DesktopSettings>('settings_get'),
    settingsSet: (patch) => call<DesktopSettings>('settings_set', { patch }),
    ask: (title, message, buttons) => call('ask', { title, message, buttons }),
    showError: (title, message) => call('show_error', { title, message }),
    trayDecorate: (art) => call('tray_decorate', { art }),
    updateStatus: () => call<UpdateSnapshot>('update_status'),
    updateCheck: (manual) => call<UpdateSnapshot>('update_check', { manual }),
    updateDownload: () => call<UpdateSnapshot>('update_download'),
    updateInstall: () => call<UpdateSnapshot>('update_install'),
    updateDismiss: () => call<UpdateSnapshot>('update_dismiss'),
  };
}
