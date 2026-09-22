import { vi } from 'vitest';
import { createDocument } from '../../src/document/factory';
import { serializeDocument } from '../../src/export/project';
import type { CommandMessage, ToHostMessage } from '../../src/host/embeddedHost';
import {
  DesktopError,
  type DesktopApi,
  type DocState,
  type FileFilter,
  type HostEvent,
  type OpenedDoc,
  type ProjectInfo,
  type QuitDecision,
  type RecentItem,
  type RecoveryEntry,
  type SavedAs,
  type TrayArt,
  type UpdateSnapshot,
} from '../../src/desktop/api';
import type { HostLink } from '../../src/desktop/channel';
import { DesktopController, type DesktopUi } from '../../src/desktop/controller';
import { DesktopStore } from '../../src/desktop/store';

export const decoder = new TextDecoder();

/** A `.draftcanvas` document's text, as the app writes it. */
export function documentText(title = 'Payments'): string {
  return serializeDocument(createDocument(title));
}

interface FakeFile {
  name: string;
  displayPath: string;
  text: string;
  /** Bumped by every write, so a stale stamp is a conflict. */
  version: number;
  readOnly?: boolean;
}

/**
 * An in-memory stand-in for the shell: files by handle, recovery entries, and scripted answers for
 * the dialogs. It follows the contract in `src/desktop/api.ts`, so the controller can be driven
 * through its whole life without a window.
 */
export function createHarness() {
  const files = new Map<string, FakeFile>();
  const recovery = new Map<string, { entry: RecoveryEntry; text: string }>();
  const sidecars = new Map<string, { mime: string; base64: string }>();
  const answers: number[] = [];
  const asked: { title: string; message: string; buttons: string[] }[] = [];
  const errors: { title: string; message: string }[] = [];
  const delivered: unknown[] = [];
  const posted: string[] = [];
  const notices: string[] = [];
  let pickedFile: string | null = null;
  let saveAsPath: { name: string; displayPath: string } | null = null;
  let hostEvents: (event: HostEvent) => void = () => {};
  let nextHandle = 1;
  let update: UpdateSnapshot = { currentVersion: '1.9.4', state: { phase: 'idle' }, dismissed: false, held: null, error: null };

  const stampOf = (file: FakeFile) => `v1:${file.version}`;
  const opened = (handle: string, file: FakeFile): OpenedDoc => ({
    handle,
    name: file.name,
    displayPath: file.displayPath,
    text: file.text,
    stamp: stampOf(file),
    readOnly: Boolean(file.readOnly),
  });

  const addFile = (name: string, text = documentText(name)): string => {
    const handle = `h_${nextHandle++}`;
    files.set(handle, { name, displayPath: `~/work/${name}.draftcanvas`, text, version: 1 });
    return handle;
  };

  // Project folders: a name, and diagrams in it by path. `listed` is the shell's project list, most
  // recent first; a folder can be on it and gone (`missing`).
  interface FakeProject {
    info: ProjectInfo;
    files: Map<string, { text: string; mtimeMs: number }>;
    missing: boolean;
  }
  const folders = new Map<string, FakeProject>();
  let listed: string[] = [];
  let pickedProject: string | null = null;
  const addProject = (name: string, diagrams: string[] = []): string => {
    const handle = `p_${nextHandle++}`;
    const at = Date.now();
    folders.set(handle, {
      info: { handle, name, displayPath: `~/work/${name}` },
      files: new Map(diagrams.map((path, i) => [path, { text: documentText(path.replace(/\.draftcanvas$/, '')), mtimeMs: at - i * 60_000 }])),
      missing: false,
    });
    return handle;
  };
  const folder = (handle: string) => {
    const found = folders.get(handle);
    if (!found || found.missing) throw new DesktopError('NotFound', 'That folder is no longer there.');
    return found;
  };
  const toFront = (handle: string) => void (listed = [handle, ...listed.filter((known) => known !== handle)]);

  const api = {
    hostReady: vi.fn(async (onEvent: (event: HostEvent) => void) => {
      hostEvents = onEvent;
      return {
        version: '1.9.4',
        platform: 'macos' as const,
        settings: { closeBehavior: 'ask' as const, autoCheckUpdates: true },
        projects: listed.filter((handle) => !folders.get(handle)!.missing).map((handle) => folders.get(handle)!.info),
        tray: true,
      };
    }),
    reportState: vi.fn(async (_state: DocState) => {}),
    quitAck: vi.fn(async (_decision: QuitDecision) => {}),
    quitNow: vi.fn(async () => {}),
    openDialog: vi.fn(async () => (pickedFile ? opened(pickedFile, files.get(pickedFile)!) : null)),
    openHandle: vi.fn(async (handle: string) => {
      const file = files.get(handle);
      if (!file) throw new DesktopError('InvalidHandle', 'That file is no longer available.');
      return opened(handle, file);
    }),
    saveDocument: vi.fn(async (handle: string, bytes: Uint8Array, expectedStamp: string | undefined) => {
      const file = files.get(handle);
      if (!file) throw new DesktopError('NotFound', 'Draft Canvas couldn’t find that file.');
      if (file.readOnly) throw new DesktopError('ReadOnly', `Draft Canvas couldn’t save ${file.name}.draftcanvas because the file is read-only.`);
      if (expectedStamp !== undefined && expectedStamp !== stampOf(file)) return { outcome: 'conflict' as const };
      file.text = decoder.decode(bytes);
      file.version += 1;
      return { outcome: 'saved' as const, stamp: stampOf(file) };
    }),
    saveAs: vi.fn(async (_suggested: string, bytes: Uint8Array): Promise<SavedAs | null> => {
      if (!saveAsPath) return null;
      const handle = addFile(saveAsPath.name, decoder.decode(bytes));
      return { handle, name: saveAsPath.name, displayPath: files.get(handle)!.displayPath, stamp: stampOf(files.get(handle)!) };
    }),
    checkStamp: vi.fn(async (handle: string, stamp: string) => {
      const file = files.get(handle);
      if (!file) return 'missing' as const;
      return stamp === stampOf(file) ? ('unchanged' as const) : ('changed' as const);
    }),
    reveal: vi.fn(async () => {}),
    exportFile: vi.fn(async (_name: string, _filters: FileFilter[], _bytes: Uint8Array) => true),
    openExternal: vi.fn(async (_url: string) => {}),
    sidecarRead: vi.fn(async (handle: string) => sidecars.get(handle) ?? null),
    sidecarWrite: vi.fn(async (handle: string, mime: string, base64: string) => void sidecars.set(handle, { mime, base64 })),
    sidecarRemove: vi.fn(async (handle: string) => void sidecars.delete(handle)),
    peekDocument: vi.fn(async (handle: string) => files.get(handle)?.text ?? null),
    projectPeek: vi.fn(async (project: string, relPath: string): Promise<string | null> => folders.get(project)?.files.get(relPath)?.text ?? null),
    pickProject: vi.fn(async (): Promise<ProjectInfo | null> => {
      if (!pickedProject) return null;
      toFront(pickedProject);
      return folder(pickedProject).info;
    }),
    openProject: vi.fn(async (handle: string) => {
      toFront(handle);
      return folder(handle).info;
    }),
    projectForget: vi.fn(async (handle: string) => void (listed = listed.filter((known) => known !== handle))),
    projectScan: vi.fn(async (handle: string) => {
      const project = folder(handle);
      return {
        files: [...project.files].map(([relPath, file]) => ({
          relPath,
          name: relPath.slice(relPath.lastIndexOf('/') + 1).replace(/\.draftcanvas$/, ''),
          mtimeMs: file.mtimeMs,
          size: file.text.length,
        })),
        truncated: false,
      };
    }),
    projectOpenFile: vi.fn(async (project: string, relPath: string) => {
      const text = folder(project).files.get(relPath)?.text;
      if (text === undefined) throw new DesktopError('NotFound', 'Draft Canvas couldn’t find that file.');
      const name = relPath.slice(relPath.lastIndexOf('/') + 1).replace(/\.draftcanvas$/, '');
      const handle = `h_${nextHandle++}`;
      files.set(handle, { name, displayPath: `${folder(project).info.displayPath}/${relPath}`, text, version: 1 });
      return opened(handle, files.get(handle)!);
    }),
    projectSaveNew: vi.fn(async (project: string, name: string, bytes: Uint8Array) => {
      const relPath = `${name}.draftcanvas`;
      folder(project).files.set(relPath, { text: decoder.decode(bytes), mtimeMs: Date.now() });
      const handle = `h_${nextHandle++}`;
      const displayPath = `${folder(project).info.displayPath}/${relPath}`;
      files.set(handle, { name, displayPath, text: decoder.decode(bytes), version: 1 });
      return { handle, name, displayPath, stamp: stampOf(files.get(handle)!) };
    }),
    recentsList: vi.fn(async (): Promise<RecentItem[]> => []),
    recentsRemove: vi.fn(async () => {}),
    recentsClear: vi.fn(async () => {}),
    recoveryWrite: vi.fn(
      async (id: string, origin: RecoveryEntry['origin'] | { kind: 'file'; handle: string; baseStamp: string }, title: string, bytes: Uint8Array) => {
        const file = origin.kind === 'file' ? files.get(origin.handle) : undefined;
        recovery.set(id, {
          text: decoder.decode(bytes),
          entry: {
            id,
            title,
            updatedAt: Date.now(),
            bytes: bytes.length,
            origin: origin.kind === 'file' && file ? { kind: 'file', name: file.name, displayPath: file.displayPath, handle: origin.handle } : { kind: 'quick' },
          },
        });
      },
    ),
    recoveryList: vi.fn(async () => [...recovery.values()].map((held) => held.entry)),
    recoveryRead: vi.fn(async (id: string) => recovery.get(id)!.text),
    recoveryDiscard: vi.fn(async (id: string) => void recovery.delete(id)),
    settingsGet: vi.fn(async () => ({ closeBehavior: 'ask' as const, autoCheckUpdates: true })),
    settingsSet: vi.fn(async (patch: { closeBehavior?: 'ask' | 'tray' | 'quit'; autoCheckUpdates?: boolean }) => ({
      closeBehavior: patch.closeBehavior ?? ('ask' as const),
      autoCheckUpdates: patch.autoCheckUpdates ?? true,
    })),
    ask: vi.fn(async (title: string, message: string, buttons: string[]) => {
      asked.push({ title, message, buttons });
      // An unscripted box is closed the way Escape closes it: the last button, which changes nothing.
      return answers.shift() ?? buttons.length - 1;
    }),
    showError: vi.fn(async (title: string, message: string) => void errors.push({ title, message })),
    trayDecorate: vi.fn(async (_art: TrayArt) => {}),
    // The shell decides everything about updates; the fake just answers with whatever the test set.
    updateStatus: vi.fn(async () => update),
    updateCheck: vi.fn(async (_manual: boolean) => update),
    updateDownload: vi.fn(async () => update),
    updateInstall: vi.fn(async () => update),
    updateDismiss: vi.fn(async () => ({ ...update, dismissed: true })),
  } satisfies DesktopApi;

  const link: HostLink = {
    deliver: (message) => {
      delivered.push(message);
      const typed = message as { type?: string; command?: CommandMessage['command']; id?: number; text?: string; seq?: number };
      // Stands in for the app: it answers a flush, opens what it is sent, and closes when told to.
      if (typed.type === 'draft-canvas:command' && typed.command === 'flush') {
        queueMicrotask(() => link.onMessage({ type: 'draft-canvas:flushed', id: typed.id! }));
      } else if (typed.type === 'draft-canvas:command' && typed.command === 'close') {
        queueMicrotask(() => link.onMessage({ type: 'draft-canvas:closed' }));
      } else if (typed.type === 'draft-canvas:load') {
        queueMicrotask(() => link.onOpened({ text: typed.text!, seq: typed.seq }));
      }
    },
    onMessage: () => {},
    onOpened: () => {},
  };

  const ui: DesktopUi = {
    openAbout: vi.fn(),
    openShortcuts: vi.fn(),
    openSettings: vi.fn(),
    notify: (message) => void notices.push(message),
    editCommand: vi.fn(),
  };

  const store = new DesktopStore();
  const controller = new DesktopController({ api, link, store, ui });
  const originalOnMessage = link.onMessage;
  link.onMessage = (message: ToHostMessage) => {
    posted.push(message.type);
    originalOnMessage(message);
  };

  const loads = () => delivered.filter((message): message is { type: 'draft-canvas:load'; text: string; title: string; seq: number } => (message as { type?: string }).type === 'draft-canvas:load');
  const settle = async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  };

  return {
    api,
    controller,
    store,
    ui,
    link,
    files,
    recovery,
    sidecars,
    delivered,
    posted,
    notices,
    errors,
    asked,
    loads,
    settle,
    addFile,
    /** The dialogs' answers, in order. */
    answer: (...choices: number[]) => void answers.push(...choices),
    pickFile: (handle: string | null) => void (pickedFile = handle),
    saveAsTo: (target: { name: string; displayPath: string } | null) => void (saveAsPath = target),
    hostEvent: (event: HostEvent) => hostEvents(event),
    /** A project folder with these diagrams (paths inside it), not yet on the list. */
    addProject,
    /** Puts projects on the shell's list, as an earlier session left it (first is most recent). */
    listProjects: (...handles: string[]) => void (listed = [...handles]),
    listedProjects: () => [...listed],
    /** What the next folder dialog picks (`null` cancels it). */
    pickFolder: (handle: string | null) => void (pickedProject = handle),
    /** The folder goes away (an unplugged drive), or comes back. */
    setMissing: (handle: string, missing: boolean) => void (folders.get(handle)!.missing = missing),
    /** What the shell's updater answers with from now on. */
    setUpdate: (next: UpdateSnapshot) => void (update = next),
    /** What the app says: a committed edit. */
    edit: (text: string, baseSeq?: number) => link.onMessage({ type: 'draft-canvas:change', text, ...(baseSeq !== undefined ? { baseSeq } : {}) }),
  };
}

export type Harness = ReturnType<typeof createHarness>;
