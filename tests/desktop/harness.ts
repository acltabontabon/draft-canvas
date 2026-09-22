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
  type QuitDecision,
  type RecentItem,
  type RecoveryEntry,
  type SavedAs,
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

  const api = {
    hostReady: vi.fn(async (onEvent: (event: HostEvent) => void) => {
      hostEvents = onEvent;
      return { version: '1.9.4', platform: 'macos' as const, settings: { closeBehavior: 'ask' as const }, lastProject: null };
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
    pickProject: vi.fn(async () => null),
    openProject: vi.fn(async () => {
      throw new Error('not used');
    }),
    projectScan: vi.fn(async () => ({ files: [], truncated: false })),
    projectOpenFile: vi.fn(async () => {
      throw new Error('not used');
    }),
    projectSaveNew: vi.fn(async () => {
      throw new Error('not used');
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
    settingsGet: vi.fn(async () => ({ closeBehavior: 'ask' as const })),
    settingsSet: vi.fn(async (patch: { closeBehavior?: 'ask' | 'tray' | 'quit' }) => ({ closeBehavior: patch.closeBehavior ?? ('ask' as const) })),
    ask: vi.fn(async (title: string, message: string, buttons: string[]) => {
      asked.push({ title, message, buttons });
      // An unscripted box is closed the way Escape closes it: the last button, which changes nothing.
      return answers.shift() ?? buttons.length - 1;
    }),
    showError: vi.fn(async (title: string, message: string) => void errors.push({ title, message })),
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
    /** What the app says: a committed edit. */
    edit: (text: string, baseSeq?: number) => link.onMessage({ type: 'draft-canvas:change', text, ...(baseSeq !== undefined ? { baseSeq } : {}) }),
  };
}

export type Harness = ReturnType<typeof createHarness>;
