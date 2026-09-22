import { createDocument } from '../document/factory';
import { deserializeDocument, fileNameFor, serializeDocument } from '../export/project';
import type { CommandMessage, LoadMessage, ToHostMessage } from '../host/embeddedHost';
import { logDiagnostic } from '../lib/diagnostics';
import type { StarterId } from '../starters';
import { loadStarters } from '../starters/load';
import {
  DesktopError,
  type DesktopApi,
  type DocState,
  type Handle,
  type HostEvent,
  type OpenedDoc,
  type ProjectInfo,
  type RecoveryEntry,
  type SavedAs,
  type UpdateSnapshot,
} from './api';
import type { HostLink } from './channel';
import type { DesktopDoc, DesktopStore, ProjectState } from './store';

/** What the controller needs from the app around it, kept out of here so this stays free of React. */
export interface DesktopUi {
  openAbout(): void;
  openShortcuts(): void;
  openSettings(): void;
  notify(message: string): void;
  /** Undo, Redo and Select All from the native Edit menu: see `dispatchEditCommand`. */
  editCommand(command: 'undo' | 'redo' | 'select-all'): void;
}

interface Clock {
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export interface ControllerDeps {
  api: DesktopApi;
  link: HostLink;
  store: DesktopStore;
  ui: DesktopUi;
  clock?: Clock;
}

type Session =
  | { kind: 'none' }
  /** A Quick Draft has no file: its working copy is a recovery entry, and `id` is that entry's. */
  | { kind: 'quick'; id: string }
  | { kind: 'file'; handle: Handle; name: string; displayPath: string; stamp: string; readOnly: boolean; recoveryId: string };

/** The app was last heard from this long ago is when a snapshot is taken: quiet for `SNAPSHOT_QUIET_MS`, or `SNAPSHOT_MAX_MS` into a steady stream of edits. */
const SNAPSHOT_QUIET_MS = 1500;
const SNAPSHOT_MAX_MS = 5000;
/** The app answers a flush as soon as its pending edits are posted; a webview that never answers mustn't hold a save or a quit. */
const FLUSH_TIMEOUT_MS = 1000;
const QUICK_DRAFT_TITLE = 'Quick Draft';

const realClock: Clock = {
  setTimeout: (run, ms) => globalThis.setTimeout(run, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
  now: () => Date.now(),
};

const encoder = new TextEncoder();

function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // `randomUUID` exists only in secure contexts; the shell's id check wants the same shape either way.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * A document's title, from its text, without parsing a whole diagram every few seconds: the
 * serializer writes `metadata` right after the format marker, so the title is always within the
 * first few hundred bytes. A draft is listed on Home under this, so two of them aren't both just
 * "Quick Draft".
 */
export function titleOf(text: string): string | null {
  const match = /"metadata":\s*\{\s*"id":\s*"(?:[^"\\]|\\.)*",\s*"title":\s*("(?:[^"\\]|\\.)*")/.exec(text.slice(0, 4096));
  if (!match) return null;
  try {
    const title = (JSON.parse(match[1]!) as string).trim();
    return title || null;
  } catch {
    return null;
  }
}

/** The message a person can act on, for whatever a command rejected with. */
function describe(error: unknown): string {
  if (error instanceof DesktopError) return error.message;
  return error instanceof Error && error.message ? error.message : 'Something unexpected went wrong.';
}

/**
 * The desktop shell's half of the conversation with the app — the part VS Code's extension plays
 * there. The app owns the canvas and says every change; this owns the file: what is open, whether it
 * has unsaved changes, saving it safely, and keeping a recoverable copy of any work that isn't in a
 * file yet, so that nothing the user drew depends on a save they haven't made.
 *
 * A file the user picked is only ever written by their own Save. Everything else — Quick Drafts and
 * the snapshots of unsaved changes — lives in the app's data folder, where a crash or a restart
 * leaves it for Home to offer back.
 */
export class DesktopController {
  private readonly api: DesktopApi;
  private readonly link: HostLink;
  private readonly store: DesktopStore;
  private readonly ui: DesktopUi;
  private readonly clock: Clock;

  private session: Session = { kind: 'none' };
  /** Counts up with every load sent; a change made on an older one is dropped (see `LoadMessage.seq`). */
  private seq = 0;
  /** The app's own serialization of the file as last saved, which is what an edit is compared with. Null until known. */
  private savedText: string | null = null;
  private latestText: string | null = null;
  /** The first `opened` after a load sets the saved baseline — except for recovered work, which is unsaved by definition. */
  private expectBaseline = true;
  /** A Quick Draft with anything in it: one left untouched has nothing worth keeping. */
  private edited = false;
  private pendingBackground: { write: { mime: string; base64: string } } | { remove: true } | null = null;
  private snapshotTimer: unknown = null;
  private snapshotFirstAt: number | null = null;
  private saving: Promise<void> | null = null;
  private flushCount = 0;
  private readonly flushes = new Map<number, () => void>();
  private lastReported = '';
  /** The open file changed or vanished outside the app: said once, and again only if that changes. */
  private outside: 'changed' | 'missing' | null = null;
  /** Anything that swaps the open document runs in turn: two requests at once (a menu pick and a tray click) mustn't interleave. */
  private turn: Promise<unknown> = Promise.resolve();

  constructor(deps: ControllerDeps) {
    this.api = deps.api;
    this.link = deps.link;
    this.store = deps.store;
    this.ui = deps.ui;
    this.clock = deps.clock ?? realClock;
    this.link.onMessage = (message) => this.onAppMessage(message);
    this.link.onOpened = (info) => this.onOpened(info);
  }

  // ─── Start-up and events from the shell ─────────────────────────────────────────────

  async start(): Promise<void> {
    const boot = await this.api.hostReady((event) => void this.onHostEvent(event));
    this.store.update({
      ready: true,
      platform: boot.platform,
      tray: boot.tray,
      settings: boot.settings,
      // Known by name only: each is listed when something shows it.
      projects: boot.projects.map((info) => ({ info, status: 'unscanned', files: [], truncated: false })),
    });
    const update = this.refreshUpdate();
    // Each refresh reports its own failure, so Home still learns that listing is over.
    await Promise.all([this.refreshRecents(), this.refreshRecovery()]);
    this.store.update({ listed: true });
    await update;
  }

  private async onHostEvent(event: HostEvent): Promise<void> {
    switch (event.type) {
      case 'open':
        return this.openHandle(event.handle);
      case 'new-quick-draft':
        return this.newQuickDraft();
      case 'new-canvas':
        return this.newCanvas();
      case 'recover-draft':
        return this.recover(event.id);
      case 'window-focused':
        return this.onFocus();
      case 'recents-changed':
        return this.refreshRecents();
      case 'notice':
        return this.ui.notify(event.message);
      case 'quit-requested':
        return this.onQuitRequested('quit');
      case 'update-requested':
        return this.onQuitRequested('update');
      case 'update':
        return void this.store.update({ update: event.snapshot });
      case 'menu':
        return this.onMenu(event.command);
    }
  }

  private async onMenu(command: Extract<HostEvent, { type: 'menu' }>['command']): Promise<void> {
    switch (command) {
      case 'save':
        return this.save();
      case 'save-as':
        return this.saveAs();
      case 'open':
        return this.openFile();
      case 'open-project':
        return void (await this.pickProject());
      case 'new-canvas':
        return this.newCanvas();
      case 'reveal':
        return this.reveal();
      case 'revert':
        return this.revert();
      case 'settings':
        return this.ui.openSettings();
      case 'about':
        return this.ui.openAbout();
      case 'shortcuts':
        return this.ui.openShortcuts();
      case 'undo':
      case 'redo':
      case 'select-all':
        return this.ui.editCommand(command);
    }
  }

  // ─── What the app says ──────────────────────────────────────────────────────────────

  private onAppMessage(message: ToHostMessage): void {
    switch (message.type) {
      case 'draft-canvas:change':
        return this.onChange(message.text, message.baseSeq);
      case 'draft-canvas:save':
        // ⌘S pressed in the canvas. The menu's own accelerator can land here too, and a save already
        // running answers both.
        void (message.saveAs ? this.saveAs() : this.save());
        return;
      case 'draft-canvas:open-external':
        void this.api.openExternal(message.url).catch((error: unknown) => logDiagnostic(error, { operation: 'desktop-open-external' }));
        return;
      case 'draft-canvas:background-write':
        this.pendingBackground = { write: { mime: message.mime, base64: message.data } };
        return;
      case 'draft-canvas:background-remove':
        this.pendingBackground = { remove: true };
        return;
      case 'draft-canvas:background-read':
        void this.replyBackground(message.id);
        return;
      case 'draft-canvas:flushed':
        this.flushes.get(message.id)?.();
        return;
      case 'draft-canvas:closed':
        this.onClosed();
        return;
      default:
        // The clipboard, chords and the like are VS Code's: this webview does those itself.
        return;
    }
  }

  private onChange(text: string, baseSeq: number | undefined): void {
    if (this.session.kind === 'none') return;
    if (baseSeq !== undefined && baseSeq < this.seq) return;
    this.latestText = text;
    if (this.session.kind === 'quick') this.edited = true;
    this.publish();
    this.scheduleSnapshot();
  }

  private onOpened(info: { text: string; seq?: number }): void {
    if (info.seq !== undefined && info.seq !== this.seq) return;
    this.latestText = info.text;
    if (this.expectBaseline) this.savedText = info.text;
    this.publish();
  }

  private async replyBackground(id: number): Promise<void> {
    let image: { mime: string; base64: string } | null = null;
    if (this.session.kind === 'file') {
      try {
        image = await this.api.sidecarRead(this.session.handle);
      } catch (error) {
        logDiagnostic(error, { operation: 'desktop-background-read' });
      }
    }
    this.link.deliver({ type: 'draft-canvas:background', id, ...(image ? { mime: image.mime, data: image.base64 } : {}) });
  }

  // ─── Document state ─────────────────────────────────────────────────────────────────

  private get dirty(): boolean {
    if (this.session.kind === 'quick') return this.edited;
    if (this.session.kind !== 'file') return false;
    return this.savedText === null || this.latestText !== this.savedText;
  }

  private get displayName(): string {
    return this.session.kind === 'file' ? this.session.name : QUICK_DRAFT_TITLE;
  }

  /** Pushes what changed to Home, the status bar and the window title. */
  private publish(): void {
    const session = this.session;
    let doc: DesktopDoc;
    let state: DocState;
    if (session.kind === 'file') {
      doc = {
        kind: 'file',
        name: session.name,
        displayPath: session.displayPath,
        dirty: this.dirty,
        readOnly: session.readOnly,
        ...(this.outside ? { outside: this.outside } : {}),
      };
      state = { kind: 'file', dirty: this.dirty, name: session.name, handle: session.handle };
    } else if (session.kind === 'quick') {
      doc = { kind: 'quick', dirty: this.dirty };
      state = { kind: 'quick', dirty: this.dirty };
    } else {
      doc = { kind: 'none' };
      state = { kind: 'none', dirty: false };
    }
    this.store.update({ doc });
    const key = JSON.stringify(state);
    if (key === this.lastReported) return;
    this.lastReported = key;
    void this.api.reportState(state).catch((error: unknown) => logDiagnostic(error, { operation: 'desktop-report-state' }));
  }

  // ─── Sending a file to the app ──────────────────────────────────────────────────────

  private load(text: string, title: string, options: { baseline: boolean }): void {
    this.seq += 1;
    this.expectBaseline = options.baseline;
    this.savedText = null;
    this.latestText = null;
    this.pendingBackground = null;
    this.outside = null;
    this.snapshotFirstAt = null;
    this.clearSnapshotTimer();
    // `background` says the shell keeps the canvas's image beside the file, as VS Code's extension does.
    const message: LoadMessage = { type: 'draft-canvas:load', text, title, seq: this.seq, background: true };
    this.link.deliver(message);
  }

  /**
   * Asks the app to let go of a field still being typed in and post what is pending, so what happens
   * next (a save, a switch, a quit) acts on exactly what is on screen.
   */
  private flushApp(): Promise<void> {
    if (this.session.kind === 'none') return Promise.resolve();
    const id = ++this.flushCount;
    return new Promise((resolve) => {
      const done = () => {
        this.clock.clearTimeout(timeout);
        this.flushes.delete(id);
        resolve();
      };
      const timeout = this.clock.setTimeout(done, FLUSH_TIMEOUT_MS);
      this.flushes.set(id, done);
      const command: CommandMessage = { type: 'draft-canvas:command', command: 'flush', id };
      this.link.deliver(command);
    });
  }

  // ─── Opening ────────────────────────────────────────────────────────────────────────

  async openFile(): Promise<void> {
    await this.swap('Couldn’t open the file', async () => {
      const opened = await this.api.openDialog();
      if (opened) await this.switchTo(opened);
    });
  }

  async openHandle(handle: Handle): Promise<void> {
    await this.swap('Couldn’t open the file', async () => this.switchTo(await this.api.openHandle(handle)));
  }

  async openProjectFile(project: Handle, relPath: string): Promise<void> {
    await this.swap('Couldn’t open the file', async () => this.switchTo(await this.api.projectOpenFile(project, relPath)));
  }

  /** Makes `opened` the open document, once whatever is open now has been settled. Returns whether it did. */
  private async switchTo(opened: OpenedDoc, recovered?: RecoveryEntry): Promise<boolean> {
    const parsed = deserializeDocument(opened.text);
    if (!parsed.ok) {
      await this.api.showError(`Draft Canvas couldn’t open ${opened.name}.draftcanvas`, parsed.error);
      return false;
    }
    if (!(await this.settleBeforeLeaving())) return false;

    let text = opened.text;
    let baseline = true;
    let recoveryId = `f_${uuid()}`;
    if (recovered) {
      text = await this.api.recoveryRead(recovered.id);
      baseline = false;
      recoveryId = recovered.id;
    } else {
      const found = (await this.api.recoveryList()).filter(
        (entry) => entry.origin.kind === 'file' && entry.origin.displayPath === opened.displayPath,
      );
      if (found.length > 0) {
        const newest = found.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));
        const choice = await this.api.ask(
          'Recover unsaved changes?',
          `Draft Canvas kept unsaved changes to ${opened.name}.draftcanvas from ${new Date(newest.updatedAt).toLocaleString()}, and the app closed before they were saved.`,
          ['Recover', 'Discard', 'Cancel'],
        );
        if (choice === 2) return false;
        for (const entry of found) if (choice === 1 || entry.id !== newest.id) await this.discard(entry.id);
        if (choice === 0) {
          text = await this.api.recoveryRead(newest.id);
          baseline = false;
          recoveryId = newest.id;
        }
      }
    }

    this.session = {
      kind: 'file',
      handle: opened.handle,
      name: opened.name,
      displayPath: opened.displayPath,
      stamp: opened.stamp,
      readOnly: opened.readOnly,
      recoveryId,
    };
    this.edited = false;
    this.load(text, opened.name, { baseline });
    this.publish();
    void this.refreshRecents();
    void this.refreshRecovery();
    return true;
  }

  /**
   * A blank canvas at once — or, from Home's starters, one already holding that starter. Either way
   * nothing is kept until it is drawn on: a starter left untouched is one click from coming back.
   */
  async newQuickDraft(starterId?: StarterId): Promise<void> {
    await this.swap('Couldn’t start a Quick Draft', async () => {
      // Fetched before anything is settled, so a starter that can't load leaves the open document alone.
      const catalog = starterId ? await loadStarters() : null;
      const starter = starterId ? catalog?.starterById(starterId) : undefined;
      if (!(await this.settleBeforeLeaving())) return;
      const document = starter && catalog ? catalog.starterDocument(starter) : createDocument(QUICK_DRAFT_TITLE);
      this.session = { kind: 'quick', id: `q_${uuid()}` };
      this.edited = false;
      this.load(serializeDocument(document), document.metadata.title, { baseline: true });
      this.publish();
    });
  }

  /** A canvas whose place is chosen first: the Save dialog opens before anything is drawn. */
  async newCanvas(): Promise<void> {
    await this.swap('Couldn’t create the canvas', async () => {
      if (!(await this.settleBeforeLeaving())) return;
      const blank = encoder.encode(serializeDocument(createDocument()));
      const saved = await this.api.saveAs('Untitled canvas', blank);
      if (!saved) {
        // Whatever was open stays open; its snapshot was settled above and is only rewritten on the next edit.
        if (this.dirty) this.scheduleSnapshot();
        return;
      }
      await this.switchTo(await this.api.openHandle(saved.handle));
    });
  }

  /** A blank canvas made straight into a project folder, under the first free "Untitled canvas" name. */
  async newCanvasIn(project: Handle): Promise<void> {
    await this.swap('Couldn’t create the canvas', async () => {
      if (!(await this.settleBeforeLeaving())) return;
      const blank = encoder.encode(serializeDocument(createDocument()));
      const saved = await this.api.projectSaveNew(project, 'Untitled canvas', blank);
      await this.switchTo(await this.api.openHandle(saved.handle));
      void this.scanProjects([project], { again: true });
    });
  }

  async recover(id: string): Promise<void> {
    const entry = this.store.getSnapshot().recovery.find((candidate) => candidate.id === id);
    if (!entry) return;
    await this.swap('Couldn’t recover the draft', async () => {
      if (entry.origin.kind === 'file') {
        let opened: OpenedDoc | null = null;
        try {
          opened = await this.api.openHandle(entry.origin.handle);
        } catch (error) {
          // The file is gone or unreadable: the work is still worth having, as a draft of its own.
          if (!(error instanceof DesktopError) || !['NotFound', 'InvalidHandle', 'PermissionDenied'].includes(error.kind)) throw error;
        }
        if (opened) {
          await this.switchTo(opened, entry);
          return;
        }
      }
      if (!(await this.settleBeforeLeaving())) return;
      const text = await this.api.recoveryRead(entry.id);
      this.session = { kind: 'quick', id: entry.id };
      this.edited = true;
      this.load(text, QUICK_DRAFT_TITLE, { baseline: true });
      this.publish();
      void this.refreshRecovery();
    });
  }

  async discardRecovery(id: string): Promise<void> {
    const entry = this.store.getSnapshot().recovery.find((candidate) => candidate.id === id);
    if (!entry) return;
    const choice = await this.api.ask('Discard this draft?', `“${entry.title}” will be deleted from this computer. This can’t be undone.`, ['Discard', 'Cancel']);
    if (choice !== 0) return;
    await this.discard(id);
    await this.refreshRecovery();
  }

  // ─── Saving ─────────────────────────────────────────────────────────────────────────

  /**
   * Saves the open document. Called from the menu, the app's own ⌘S and the status bar alike, so a
   * save already running is the answer to a second request rather than a second dialog.
   */
  save(): Promise<void> {
    this.saving ??= this.saveNow().finally(() => {
      this.saving = null;
      this.store.update({ saving: false });
    });
    return this.saving;
  }

  private async saveNow(): Promise<void> {
    await this.flushApp();
    const session = this.session;
    if (session.kind === 'none') return;
    if (session.kind === 'quick') {
      await this.guard('Couldn’t save', () => this.saveAsFlow());
      return;
    }
    if (!this.dirty) return;
    await this.guard(`Couldn’t save ${session.name}.draftcanvas`, async () => {
      const text = this.latestText;
      if (text === null) return;
      this.store.update({ saving: true });
      const bytes = encoder.encode(text);
      let result = await this.api.saveDocument(session.handle, bytes, session.stamp);
      if (result.outcome === 'conflict') {
        const choice = await this.api.ask(
          `${session.name}.draftcanvas changed on disk`,
          'It was changed by something else since you opened it. Overwriting it replaces those changes with what is on your screen.',
          ['Overwrite', 'Save As…', 'Cancel'],
        );
        if (choice === 2) return;
        if (choice === 1) {
          await this.saveAsFlow();
          return;
        }
        result = await this.api.saveDocument(session.handle, bytes, undefined);
      }
      if (result.outcome !== 'saved') return;
      session.stamp = result.stamp;
      this.savedText = text;
      await this.applyBackground(session.handle);
      await this.discard(session.recoveryId);
      this.clearSnapshotTimer();
      this.outside = null;
      this.publish();
    });
  }

  saveAs(): Promise<void> {
    this.saving ??= this.saveAsNow().finally(() => {
      this.saving = null;
      this.store.update({ saving: false });
    });
    return this.saving;
  }

  private async saveAsNow(): Promise<void> {
    await this.flushApp();
    if (this.session.kind === 'none') return;
    await this.guard('Couldn’t save', () => this.saveAsFlow());
  }

  /** Save As for a file, and the first Save of a Quick Draft. */
  private async saveAsFlow(): Promise<void> {
    const session = this.session;
    const text = this.latestText ?? this.savedText;
    if (session.kind === 'none' || text === null) return;
    const saved = await this.api.saveAs(
      this.suggestedName(text),
      encoder.encode(text),
      session.kind === 'file' && !this.pendingBackground ? session.handle : undefined,
    );
    if (saved) await this.becomeFile(saved, text);
  }

  /**
   * "Move into Project…": a Quick Draft becomes a file in a project folder, without a dialog — the one
   * named, or the most recent, or one picked now.
   */
  async moveIntoProject(handle?: Handle): Promise<void> {
    await this.flushApp();
    if (this.session.kind !== 'quick') return;
    await this.swap('Couldn’t move the draft', async () => {
      const project = this.projects.find((candidate) => candidate.info.handle === handle)?.info ?? this.projects[0]?.info ?? (await this.pickProject());
      const text = this.latestText ?? this.savedText;
      if (!project || text === null) return;
      const saved = await this.api.projectSaveNew(project.handle, this.suggestedName(text), encoder.encode(text));
      await this.becomeFile(saved, text);
      await this.scanProjects([project.handle], { again: true });
    });
  }

  private async becomeFile(saved: SavedAs, text: string): Promise<void> {
    const before = this.session;
    this.session = {
      kind: 'file',
      handle: saved.handle,
      name: saved.name,
      displayPath: saved.displayPath,
      stamp: saved.stamp,
      readOnly: false,
      recoveryId: `f_${uuid()}`,
    };
    await this.applyBackground(saved.handle);
    this.savedText = text;
    this.latestText = text;
    this.edited = false;
    this.clearSnapshotTimer();
    this.outside = null;
    if (before.kind === 'quick') await this.discard(before.id);
    else if (before.kind === 'file') await this.discard(before.recoveryId);
    this.publish();
    void this.refreshRecents();
    void this.refreshRecovery();
  }

  /** The image is the shell's to keep beside the file, and only a save moves it there. */
  private async applyBackground(handle: Handle): Promise<void> {
    const pending = this.pendingBackground;
    if (!pending) return;
    this.pendingBackground = null;
    try {
      if ('write' in pending) await this.api.sidecarWrite(handle, pending.write.mime, pending.write.base64);
      else await this.api.sidecarRemove(handle);
    } catch (error) {
      // The file itself is saved; only its picture isn't, and the canvas still shows it this session.
      logDiagnostic(error, { operation: 'desktop-background-save' });
      this.ui.notify('Saved, but the background image couldn’t be saved beside the file.');
    }
  }

  private suggestedName(text: string): string {
    try {
      const title = (JSON.parse(text) as { metadata?: { title?: unknown } }).metadata?.title;
      if (typeof title === 'string' && title.trim()) return fileNameFor(title, '');
    } catch {
      // A document that won't parse has no title to offer.
    }
    return QUICK_DRAFT_TITLE;
  }

  /** "Revert to Saved…": the file's own contents replace what is on screen. */
  async revert(): Promise<void> {
    const session = this.session;
    if (session.kind !== 'file') return;
    await this.swap('Couldn’t revert', async () => {
      if (this.dirty) {
        const choice = await this.api.ask(
          `Revert to the saved ${session.name}?`,
          'Changes you made since you last saved it will be lost.',
          ['Revert', 'Cancel'],
        );
        if (choice !== 0) return;
      }
      await this.reload(session);
    });
  }

  private async reload(session: Extract<Session, { kind: 'file' }>): Promise<void> {
    const opened = await this.api.openHandle(session.handle);
    if (!deserializeDocument(opened.text).ok) {
      await this.api.showError(`Draft Canvas couldn’t read ${opened.name}.draftcanvas`, 'What is on disk is not a valid diagram, so what is on screen was left as it is.');
      return;
    }
    await this.discard(session.recoveryId);
    session.stamp = opened.stamp;
    session.readOnly = opened.readOnly;
    this.edited = false;
    this.load(opened.text, opened.name, { baseline: true });
    this.publish();
  }

  async reveal(): Promise<void> {
    if (this.session.kind !== 'file') return;
    const handle = this.session.handle;
    await this.guard('Couldn’t show the file', () => this.api.reveal(handle));
  }

  // ─── Leaving the open document ──────────────────────────────────────────────────────

  /**
   * Settles the open document before another takes its place: a Quick Draft is kept (it stays on
   * Home), a file with unsaved changes asks. Returns false if the user changed their mind.
   */
  private async settleBeforeLeaving(): Promise<boolean> {
    await this.flushApp();
    const session = this.session;
    if (session.kind === 'none') return true;
    if (session.kind === 'quick') {
      if (this.edited) await this.snapshotNow();
      else await this.discard(session.id);
      return true;
    }
    if (!this.dirty) return true;
    const choice = await this.api.ask(
      `Save the changes to ${session.name}.draftcanvas?`,
      'Your changes will be lost if you don’t save them.',
      ['Save', 'Don’t Save', 'Cancel'],
    );
    if (choice === 2) return false;
    if (choice === 0) {
      await this.save();
      // A save that was cancelled or failed leaves the file dirty: the user is not done with it.
      return !this.dirty;
    }
    await this.discard(session.recoveryId);
    return true;
  }

  /** Back to Home from the open document. */
  async returnHome(): Promise<void> {
    if (this.session.kind === 'none') return;
    await this.swap('Couldn’t close the document', async () => {
      if (!(await this.settleBeforeLeaving())) return;
      const command: CommandMessage = { type: 'draft-canvas:command', command: 'close' };
      this.link.deliver(command);
    });
  }

  private onClosed(): void {
    this.session = { kind: 'none' };
    this.savedText = null;
    this.latestText = null;
    this.edited = false;
    this.pendingBackground = null;
    this.clearSnapshotTimer();
    this.publish();
    void this.refreshRecents();
    void this.refreshRecovery();
    void this.refreshProjects();
  }

  // ─── Recovery snapshots ─────────────────────────────────────────────────────────────

  private get recoveryId(): string | null {
    if (this.session.kind === 'quick') return this.session.id;
    return this.session.kind === 'file' ? this.session.recoveryId : null;
  }

  private scheduleSnapshot(): void {
    if (!this.dirty) return;
    const now = this.clock.now();
    this.snapshotFirstAt ??= now;
    this.clearSnapshotTimer();
    const wait = Math.min(SNAPSHOT_QUIET_MS, Math.max(0, SNAPSHOT_MAX_MS - (now - this.snapshotFirstAt)));
    this.snapshotTimer = this.clock.setTimeout(() => void this.snapshotNow(), wait);
  }

  private clearSnapshotTimer(): void {
    if (this.snapshotTimer !== null) this.clock.clearTimeout(this.snapshotTimer);
    this.snapshotTimer = null;
  }

  /** Writes the working copy into the app's data folder. The user's file is never touched here. */
  private async snapshotNow(): Promise<void> {
    this.clearSnapshotTimer();
    this.snapshotFirstAt = null;
    const session = this.session;
    const id = this.recoveryId;
    const text = this.latestText;
    if (session.kind === 'none' || !id || text === null || !this.dirty) return;
    try {
      await this.api.recoveryWrite(
        id,
        session.kind === 'quick' ? { kind: 'quick' } : { kind: 'file', handle: session.handle, baseStamp: session.stamp },
        session.kind === 'quick' ? (titleOf(text) ?? QUICK_DRAFT_TITLE) : this.displayName,
        encoder.encode(text),
      );
    } catch (error) {
      // Losing a snapshot costs only what a crash would have cost; it must not interrupt the drawing.
      logDiagnostic(error, { operation: 'desktop-snapshot' });
    }
  }

  private async discard(id: string): Promise<void> {
    try {
      await this.api.recoveryDiscard(id);
    } catch (error) {
      logDiagnostic(error, { operation: 'desktop-recovery-discard' });
    }
  }

  // ─── Quit, focus ────────────────────────────────────────────────────────────────────

  /**
   * The user asked to quit, or to restart into an update. Anything unsaved is snapshotted first, so
   * this only ever waits on a question about a named file — a Quick Draft never asks. Logging out or
   * shutting down never reaches here: the shell doesn't get to wait then, and the snapshot is what
   * covers it.
   */
  private async onQuitRequested(reason: 'quit' | 'update'): Promise<void> {
    try {
      await this.flushApp();
      const session = this.session;
      if (session.kind === 'none') return void (await this.api.quitAck('ready'));
      if (session.kind === 'quick') {
        if (this.edited) await this.snapshotNow();
        return void (await this.api.quitAck('ready'));
      }
      if (this.dirty) await this.snapshotNow();
      if (!this.dirty) return void (await this.api.quitAck('ready'));
      await this.api.quitAck('prompting');
      const choice = await this.api.ask(
        reason === 'update'
          ? `Save the changes to ${session.name}.draftcanvas before updating?`
          : `Save the changes to ${session.name}.draftcanvas?`,
        reason === 'update'
          ? 'Draft Canvas restarts to finish the update. Your changes will be lost if you don’t save them.'
          : 'Your changes will be lost if you don’t save them.',
        ['Save', 'Don’t Save', 'Cancel'],
      );
      if (choice === 2) return void (await this.api.quitAck('cancel'));
      if (choice === 0) {
        await this.save();
        return void (await this.api.quitAck(this.dirty ? 'cancel' : 'ready'));
      }
      await this.discard(session.recoveryId);
      await this.api.quitAck('ready');
    } catch (error) {
      logDiagnostic(error, { operation: 'desktop-quit' });
      await this.api.quitAck('ready').catch(() => {});
    }
  }

  /** Coming back to the window: has the open file changed under us? One `stat`, only now. */
  private async onFocus(): Promise<void> {
    const session = this.session;
    if (session.kind === 'none') {
      await this.refreshProjects();
      return;
    }
    if (session.kind !== 'file' || this.saving) return;
    try {
      const check = await this.api.checkStamp(session.handle, session.stamp);
      if (check === 'unchanged') return;
      if (check === 'changed' && !this.dirty) {
        await this.reload(session);
        this.ui.notify(`${session.name}.draftcanvas was changed outside Draft Canvas, so it was reloaded.`);
        return;
      }
      if (this.outside === check) return;
      this.outside = check;
      this.publish();
      if (check === 'missing') this.ui.notify(`${session.name}.draftcanvas was moved or deleted. Save As… keeps your work.`);
    } catch (error) {
      logDiagnostic(error, { operation: 'desktop-check-stamp' });
    }
  }

  // ─── Projects, recents, settings ────────────────────────────────────────────────────

  /** Picks a folder and puts it first on the project list, scanned. */
  async pickProject(): Promise<ProjectInfo | null> {
    let info: ProjectInfo | null = null;
    await this.guard('Couldn’t add the project', async () => {
      info = await this.api.pickProject();
      if (info) await this.bringForward(info);
    });
    return info;
  }

  /** A project chosen from somewhere (an old Recent entry, Home): first on the list, scanned. */
  async openProject(handle: Handle): Promise<void> {
    await this.guard('Couldn’t open the project', async () => this.bringForward(await this.api.openProject(handle)));
  }

  /** Takes a project off the list. The folder and its files are left exactly as they are. */
  async forgetProject(handle: Handle): Promise<void> {
    await this.guard('Couldn’t remove the project', async () => {
      await this.api.projectForget(handle);
      this.setProjects(this.projects.filter((project) => project.info.handle !== handle));
    });
  }

  private get projects() {
    return this.store.getSnapshot().projects;
  }

  private setProjects(projects: ProjectState[]): void {
    this.store.update({ projects });
  }

  private async bringForward(info: ProjectInfo): Promise<void> {
    const known = this.projects.find((project) => project.info.handle === info.handle);
    this.setProjects([
      known ? { ...known, info } : { info, status: 'unscanned', files: [], truncated: false },
      ...this.projects.filter((project) => project.info.handle !== info.handle),
    ]);
    await this.scanProjects([info.handle], { again: true });
  }

  /**
   * Lists the diagrams in these projects: names and dates only, never the diagrams themselves. A
   * project already listed isn't listed again unless `again`, so whatever shows a project can ask
   * for it freely. Two folders at a time: a slow drive holds up one lane, not the window.
   */
  async scanProjects(handles: Handle[], { again = false }: { again?: boolean } = {}): Promise<void> {
    const wanted = handles.filter((handle) => {
      const project = this.projects.find((candidate) => candidate.info.handle === handle);
      return project && project.status !== 'scanning' && (again || project.status === 'unscanned');
    });
    if (wanted.length === 0) return;
    this.setProjects(this.projects.map((project) => (wanted.includes(project.info.handle) ? { ...project, status: 'scanning' } : project)));
    const queue = [...wanted];
    const lane = async () => {
      for (let handle = queue.shift(); handle !== undefined; handle = queue.shift()) {
        let next: Pick<ProjectState, 'status' | 'files' | 'truncated'>;
        try {
          const scan = await this.api.projectScan(handle);
          next = { status: 'ready', files: scan.files, truncated: scan.truncated };
        } catch (error) {
          logDiagnostic(error, { operation: 'desktop-project-scan' });
          // Gone for now (an unplugged drive, a deleted checkout): still on the list, shown as missing.
          next = { status: 'missing', files: [], truncated: false };
        }
        const done = handle;
        this.setProjects(this.projects.map((project) => (project.info.handle === done ? { ...project, ...next } : project)));
      }
    };
    await Promise.all([lane(), lane()]);
  }

  /** Every project that has been listed, listed again: after a save, or coming back to the window. */
  async refreshProjects(): Promise<void> {
    const shown = this.projects.filter((project) => project.status !== 'unscanned').map((project) => project.info.handle);
    await this.scanProjects(shown, { again: true });
  }

  /**
   * The text Home draws a tile's thumbnail from. Looking, never opening: nothing goes into Recent,
   * and anything that can't be looked at is `null` rather than an error — the tile shows a blank
   * sheet, and opening the file for real is what reports the problem.
   */
  async peek(
    target: { kind: 'recent'; handle: Handle } | { kind: 'project'; project: Handle; relPath: string } | { kind: 'draft'; id: string },
  ): Promise<string | null> {
    try {
      if (target.kind === 'draft') return await this.api.recoveryRead(target.id);
      if (target.kind === 'recent') return await this.api.peekDocument(target.handle);
      return await this.api.projectPeek(target.project, target.relPath);
    } catch {
      return null;
    }
  }

  async forgetRecent(handle: Handle): Promise<void> {
    await this.api.recentsRemove(handle);
    await this.refreshRecents();
  }

  async clearRecents(): Promise<void> {
    await this.api.recentsClear();
    await this.refreshRecents();
  }

  async setCloseBehavior(closeBehavior: 'ask' | 'tray' | 'quit'): Promise<void> {
    const settings = await this.api.settingsSet({ closeBehavior });
    this.store.update({ settings });
  }

  async setAutoCheckUpdates(autoCheckUpdates: boolean): Promise<void> {
    const settings = await this.api.settingsSet({ autoCheckUpdates });
    this.store.update({ settings });
  }

  // ─── Updates ────────────────────────────────────────────────────────────────────────
  // The shell decides everything; these only ask, and take the snapshot it answers with. A failure is
  // in the snapshot, worded for a person, so none of these throws at the interface.

  checkForUpdate(): Promise<void> {
    return this.updateStep(() => this.api.updateCheck(true));
  }

  downloadUpdate(): Promise<void> {
    return this.updateStep(() => this.api.updateDownload());
  }

  /** Asks the quit question first; when the answer is to go ahead, this process ends. */
  installUpdate(): Promise<void> {
    return this.updateStep(() => this.api.updateInstall());
  }

  dismissUpdate(): Promise<void> {
    this.store.update({ updateOpen: false });
    return this.updateStep(() => this.api.updateDismiss());
  }

  private async refreshUpdate(): Promise<void> {
    await this.updateStep(() => this.api.updateStatus());
  }

  private async updateStep(run: () => Promise<UpdateSnapshot>): Promise<void> {
    try {
      this.store.update({ update: await run() });
    } catch (error) {
      logDiagnostic(error, { operation: 'desktop-update' });
    }
  }

  private async refreshRecents(): Promise<void> {
    try {
      this.store.update({ recents: await this.api.recentsList() });
    } catch (error) {
      logDiagnostic(error, { operation: 'desktop-recents' });
    }
  }

  private async refreshRecovery(): Promise<void> {
    try {
      const open = this.recoveryId;
      // What is open on screen is not something to offer back.
      this.store.update({ recovery: (await this.api.recoveryList()).filter((entry) => entry.id !== open) });
    } catch (error) {
      logDiagnostic(error, { operation: 'desktop-recovery' });
    }
  }

  // ─── Errors ─────────────────────────────────────────────────────────────────────────

  /** `guard`, after every earlier swap of the open document has finished. */
  private swap(title: string, run: () => Promise<unknown>): Promise<void> {
    const next = this.turn.then(() => this.guard(title, run));
    this.turn = next;
    return next;
  }

  /** Runs one action, turning a refusal from the shell into a message a person can act on. */
  private async guard(title: string, run: () => Promise<unknown>): Promise<void> {
    try {
      await run();
    } catch (error) {
      logDiagnostic(error, { operation: 'desktop-action' });
      await this.api.showError(title, describe(error)).catch(() => {});
    }
  }
}
