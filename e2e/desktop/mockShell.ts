import type { Page } from '@playwright/test';

/**
 * A stand-in for the desktop shell (`src-tauri/`), installed into the page before the app loads:
 * the app's calls into Tauri (`window.__TAURI_INTERNALS__.invoke`) are answered from memory, so the
 * whole desktop flow — Home, Quick Draft, Save, recovery, the native menu — runs in Chromium against
 * the real editor. What it cannot show is the shell itself (windows, tray, dialogs, the OS), which
 * `cargo test` and the packaging job cover instead.
 *
 * Tests reach the shell through `window.__shell`, typed below.
 */
export interface ShellHandle {
  /** What the page answered an agent request with, by request id. */
  agentResponse(id: number): unknown;
  /** Holds every agent request at its commit gate until released (or cancelled), so a test can see it mid-way. */
  holdGate(hold: boolean): void;
  /** Stage phrases the page passed on for requesting agents. */
  agentProgress(): { id: number; message: string }[];
  /** Adds a file to the fake disk. */
  addFile(name: string, text: string): string;
  file(handle: string): { name: string; text: string; version: number } | undefined;
  /** What the next Open dialog picks (`null` cancels it). */
  nextOpen(handle: string | null): void;
  /** Where the next Save dialog saves (`null` cancels it). */
  nextSaveAs(target: { name: string } | null): void;
  /** Answers for the native message boxes, in order: the index of the button pressed. */
  answer(...choices: number[]): void;
  /** The next export's Save dialog is cancelled. */
  cancelNextExport(): void;
  /** What the app last drew for the tray menu. */
  trayArt(): unknown;
  /**
   * What an earlier session left behind, set before the app starts: recent files and unsaved drafts,
   * each `ago` milliseconds old.
   */
  seed(history: {
    recents?: { name: string; text: string; ago: number }[];
    drafts?: { title: string; text: string; ago: number }[];
    /** Project folders on the list, most recent first: each diagram by its path in the folder. */
    projects?: { name: string; path?: string; diagrams: { path: string; text: string; ago: number }[] }[];
  }): void;
  /** What the next folder dialog picks: a project by name (from `seed`), or `null` to cancel. */
  nextFolder(name: string | null): void;
  /** Something the shell tells the app on its own: a menu pick, a file the OS opened. */
  emit(event: unknown): void;
  /** Where the updater stands from now on; the page hears of it as the shell would tell it. */
  setUpdate(snapshot: unknown): void;
  /** Every command the app called, in order. */
  calls(): { command: string; args: unknown }[];
  exports(): { name: string; text: string }[];
  recoveryIds(): string[];
  /** What the message boxes said. */
  asked(): { title: string; message: string; buttons: string[] }[];
}

declare global {
  interface Window {
    __shell: ShellHandle;
  }
}

export async function installMockShell(page: Page): Promise<void> {
  await page.addInitScript(() => {
    interface Held {
      name: string;
      displayPath: string;
      text: string;
      version: number;
    }
    interface ChannelLike {
      id: number;
    }
    const files = new Map<string, Held>();
    const recovery = new Map<string, { entry: Record<string, unknown>; text: string }>();
    const sidecars = new Map<string, { mime: string; base64: string }>();
    const calls: { command: string; args: unknown }[] = [];
    const exported: { name: string; text: string }[] = [];
    const asked: { title: string; message: string; buttons: string[] }[] = [];
    const answers: number[] = [];
    const recents: { handle: string; kind: string; name: string; displayPath: string; lastOpenedMs: number }[] = [];
    let handles = 0;
    let pickedOpen: string | null = null;
    let saveTarget: { name: string } | null = null;
    let cancelExport = false;
    let trayArt: unknown = null;
    let update: Record<string, unknown> = { currentVersion: '1.9.4', state: { phase: 'idle' }, dismissed: false, held: null, error: null };
    const agentResponses = new Map<number, unknown>();
    let gateHeld = false;
    const gatePassed = new Set<number>();
    const agentCancelled = new Set<number>();
    const progressLog: { id: number; message: string }[] = [];
    // Which listed folders agents may use; Settings lists every one the shell knows.
    const agentFolders = new Map<string, boolean>();
    const agentView = () => ({
      ...agentSettings,
      projects: listedProjects.map((handle) => ({ ...folder(handle).info, agent: agentFolders.get(handle) ?? false })),
    });
    let agentSettings: Record<string, unknown> = { enabled: false, listening: false, connections: 0, sidecarPath: '/Applications/Draft Canvas.app/Contents/MacOS/draft-canvas-mcp', sidecarWarning: null, background: 'restart-needed', projects: [] };
    let settings: Record<string, unknown> = { closeBehavior: 'ask', autoCheckUpdates: true };
    let events: ChannelLike | null = null;
    let eventIndex = 0;
    const decode = (bytes: unknown) => new TextDecoder().decode(bytes as Uint8Array);
    const stamp = (file: Held) => `v1:${file.version}`;
    const win = window as unknown as Record<string, unknown>;

    const opened = (handle: string, file: Held) => ({
      handle,
      name: file.name,
      displayPath: file.displayPath,
      text: file.text,
      stamp: stamp(file),
      readOnly: false,
    });
    const touch = (handle: string, file: Held) => {
      const at = recents.findIndex((item) => item.handle === handle);
      if (at >= 0) recents.splice(at, 1);
      recents.unshift({ handle, kind: 'file', name: file.name, displayPath: file.displayPath, lastOpenedMs: Date.now() });
    };
    const addFile = (name: string, text: string) => {
      const handle = `h_${(handles += 1)}`;
      files.set(handle, { name, displayPath: `~/work/${name}.draftcanvas`, text, version: 1 });
      return handle;
    };
    const emit = (event: unknown) => {
      if (!events) return;
      (win[`_${events.id}`] as (message: unknown) => void)({ message: event, index: eventIndex++ });
    };
    const meta = (options: unknown) => {
      const header = (options as { headers?: Record<string, string> } | undefined)?.headers?.['x-meta'];
      return header ? (JSON.parse(decodeURIComponent(header)) as Record<string, unknown>) : {};
    };

    // Project folders, by handle, and the shell's list of them (most recent first).
    const folders = new Map<string, { info: { handle: string; name: string; displayPath: string }; files: Map<string, { text: string; mtimeMs: number }> }>();
    let listedProjects: string[] = [];
    /** Handles granted for a file inside a project, and which file. */
    const granted = new Map<string, { project: string; relPath: string }>();
    let pickedFolder: string | null = null;
    const folder = (handle: string) => {
      const found = folders.get(handle);
      if (!found) throw { kind: 'NotFound', message: 'That folder is no longer there.' };
      return found;
    };
    const stemOf = (relPath: string) => relPath.slice(relPath.lastIndexOf('/') + 1).replace(/\.draftcanvas$/, '');
    /**
     * The shell grants one handle per file on disk, however it is reached — so a project nested inside
     * another (both on Home) hands out the same handle for the file they share, as `insert_file` does.
     * A file already granted keeps its handle and the text it holds (it may have been saved since).
     */
    const grantInProject = (projectHandle: string, relPath: string, text: string) => {
      const displayPath = `${folder(projectHandle).info.displayPath}/${relPath}`;
      for (const [handle, held] of files) if (held.displayPath === displayPath) return handle;
      const handle = `h_${(handles += 1)}`;
      files.set(handle, { name: stemOf(relPath), displayPath, text, version: 1 });
      return handle;
    };
    const toFront = (handle: string) => void (listedProjects = [handle, ...listedProjects.filter((known) => known !== handle)]);

    // Each handler names the arguments it reads; `never` lets them all live in one table.
    const commands: Record<string, (args: never, options?: unknown) => unknown> = {
      host_ready: (args: { onEvent: ChannelLike }) => {
        events = args.onEvent;
        eventIndex = 0;
        return { version: '1.9.4', platform: 'macos', settings, projects: listedProjects.map((handle) => folder(handle).info), tray: true };
      },
      report_state: () => null,
      quit_ack: () => null,
      quit_now: () => null,
      open_dialog: () => {
        if (!pickedOpen) return null;
        const file = files.get(pickedOpen)!;
        touch(pickedOpen, file);
        return opened(pickedOpen, file);
      },
      open_handle: (args: { handle: string }) => {
        const file = files.get(args.handle);
        if (!file) throw { kind: 'InvalidHandle', message: 'That file is no longer available.' };
        touch(args.handle, file);
        return opened(args.handle, file);
      },
      rename_file: (args: { handle: string; newStem: string }) => {
        const file = files.get(args.handle);
        if (!file) throw { kind: 'InvalidHandle', message: 'That file is no longer available.' };
        const dir = file.displayPath.slice(0, file.displayPath.lastIndexOf('/') + 1);
        files.delete(args.handle);
        const handle = `h_${(handles += 1)}`;
        const renamed: Held = { name: args.newStem, displayPath: `${dir}${args.newStem}.draftcanvas`, text: file.text, version: file.version };
        files.set(handle, renamed);
        if (recents.some((item) => item.handle === args.handle)) touch(handle, renamed);
        // A file inside a project moves in that project's listing too, as it would on disk.
        const grant = granted.get(args.handle);
        if (grant) {
          const listing = folder(grant.project).files;
          const entry = listing.get(grant.relPath);
          const at = grant.relPath.lastIndexOf('/');
          if (entry) {
            listing.delete(grant.relPath);
            listing.set(`${at >= 0 ? grant.relPath.slice(0, at + 1) : ''}${args.newStem}.draftcanvas`, entry);
          }
          granted.delete(args.handle);
        }
        return { handle, name: renamed.name, displayPath: renamed.displayPath };
      },
      project_grant_file: (args: { projectHandle: string; relPath: string }) => {
        const project = folder(args.projectHandle);
        const file = project.files.get(args.relPath);
        if (!file) throw { kind: 'NotFound', message: 'Draft Canvas couldn’t find that file.' };
        const handle = grantInProject(args.projectHandle, args.relPath, file.text);
        granted.set(handle, { project: args.projectHandle, relPath: args.relPath });
        return handle;
      },
      save_document: (bytes: unknown, options: unknown) => {
        const { handle, expectedStamp } = meta(options) as { handle: string; expectedStamp?: string };
        const file = files.get(handle)!;
        if (expectedStamp !== undefined && expectedStamp !== stamp(file)) return { outcome: 'conflict' };
        file.text = decode(bytes);
        file.version += 1;
        return { outcome: 'saved', stamp: stamp(file) };
      },
      save_as: (bytes: unknown) => {
        if (!saveTarget) return null;
        const handle = addFile(saveTarget.name, decode(bytes));
        const file = files.get(handle)!;
        touch(handle, file);
        return { handle, name: file.name, displayPath: file.displayPath, stamp: stamp(file) };
      },
      check_stamp: (args: { handle: string; stamp: string }) => {
        const file = files.get(args.handle);
        return !file ? 'missing' : args.stamp === stamp(file) ? 'unchanged' : 'changed';
      },
      reveal: () => null,
      export_file: (bytes: unknown, options: unknown) => {
        if (cancelExport) {
          cancelExport = false;
          return false;
        }
        exported.push({ name: (meta(options) as { name: string }).name, text: decode(bytes) });
        return true;
      },
      open_external: () => null,
      sidecar_read: (args: { handle: string }) => sidecars.get(args.handle) ?? null,
      sidecar_write: (args: { handle: string; mime: string; base64: string }) => void sidecars.set(args.handle, args),
      sidecar_remove: (args: { handle: string }) => void sidecars.delete(args.handle),
      peek_document: (args: { handle: string }) => files.get(args.handle)?.text ?? null,
      project_peek: (args: { projectHandle: string; relPath: string }) => folders.get(args.projectHandle)?.files.get(args.relPath)?.text ?? null,
      pick_project: () => {
        if (!pickedFolder) return null;
        toFront(pickedFolder);
        return folder(pickedFolder).info;
      },
      open_project: (args: { handle: string }) => {
        toFront(args.handle);
        return folder(args.handle).info;
      },
      project_forget: (args: { handle: string }) => void (listedProjects = listedProjects.filter((known) => known !== args.handle)),
      project_scan: (args: { handle: string }) => ({
        files: [...folder(args.handle).files].map(([relPath, file]) => ({ relPath, name: stemOf(relPath), mtimeMs: file.mtimeMs, size: file.text.length })),
        truncatedDirs: [],
      }),
      project_open_file: (args: { projectHandle: string; relPath: string }) => {
        const project = folder(args.projectHandle);
        const text = project.files.get(args.relPath)?.text;
        if (text === undefined) throw { kind: 'NotFound', message: 'Draft Canvas couldn’t find that file.' };
        const handle = grantInProject(args.projectHandle, args.relPath, text);
        touch(handle, files.get(handle)!);
        return opened(handle, files.get(handle)!);
      },
      recents_list: () => recents,
      recents_remove: (args: { handle: string }) => {
        const at = recents.findIndex((item) => item.handle === args.handle);
        if (at >= 0) recents.splice(at, 1);
        return null;
      },
      recents_clear: () => void (recents.length = 0),
      recovery_write: (bytes: unknown, options: unknown) => {
        const { id, origin, title } = meta(options) as { id: string; origin: { kind: string; handle?: string }; title: string };
        const file = origin.kind === 'file' ? files.get(origin.handle!) : undefined;
        const text = decode(bytes);
        recovery.set(id, {
          text,
          entry: {
            id,
            title,
            updatedAt: Date.now(),
            bytes: text.length,
            origin: file ? { kind: 'file', name: file.name, displayPath: file.displayPath, handle: origin.handle } : { kind: 'quick' },
          },
        });
        return null;
      },
      recovery_list: () => [...recovery.values()].map((held) => held.entry),
      recovery_read: (args: { id: string }) => ({ text: recovery.get(args.id)!.text }),
      recovery_discard: (args: { id: string }) => void recovery.delete(args.id),
      settings_get: () => settings,
      settings_set: (args: { patch: Record<string, unknown> }) => (settings = { ...settings, ...args.patch }),
      ask: (args: { title: string; message: string; buttons: string[] }) => {
        asked.push(args);
        return answers.shift() ?? args.buttons.length - 1;
      },
      show_error: () => null,
      tray_decorate: (args: { art: unknown }) => void (trayArt = args.art),
      // The tray panel's own three (`capabilities/tray.json`), answered the way the shell would.
      tray_panel: () => ({
        recents: recents
          .filter((item) => item.kind === 'file')
          .slice(0, 6)
          .map((item) => ({ choice: `recent:${item.handle}`, handle: item.handle, name: item.name, openedMs: item.lastOpenedMs })),
        drafts: [...recovery.values()].slice(0, 3).map(({ entry }) => ({
          choice: `draft:${entry.id as string}`,
          id: entry.id,
          title: entry.title,
          updatedMs: entry.updatedAt,
        })),
      }),
      tray_choose: () => null,
      tray_panel_fit: () => null,
      // The updater: it answers with whatever the test set; what each step does is Rust's, tested there.
      update_status: () => update,
      update_check: () => update,
      update_download: () => update,
      update_install: () => update,
      update_dismiss: () => (update = { ...update, dismissed: true }),
      // The agent bridge: what the page says back is recorded for a test to read.
      agent_ack: () => null,
      agent_gate: async (args: { id: number }) => {
        while (gateHeld && !agentCancelled.has(args.id)) await new Promise((resolve) => setTimeout(resolve, 20));
        if (agentCancelled.has(args.id)) return false;
        gatePassed.add(args.id);
        return true;
      },
      agent_cancel: (args: { id: number }) => {
        if (gatePassed.has(args.id)) return false;
        agentCancelled.add(args.id);
        return true;
      },
      agent_progress: (args: { id: number; message: string }) => void progressLog.push(args),
      agent_respond: (args: { id: number; outcome: unknown }) => void agentResponses.set(args.id, args.outcome),
      agent_status: () => agentView(),
      agent_configure: (args: { patch: { enabled?: boolean; project?: { handle: string; agent: boolean }; rotate?: boolean } }) => {
        if (args.patch.enabled !== undefined) agentSettings = { ...agentSettings, enabled: args.patch.enabled, listening: args.patch.enabled };
        if (args.patch.project) agentFolders.set(args.patch.project.handle, args.patch.project.agent);
        if (args.patch.rotate) agentSettings = { ...agentSettings, connections: 0 };
        return agentView();
      },
    };

    // What `@tauri-apps/api/core` needs of the page: a way to register the callbacks a `Channel` calls back into.
    let callbacks = 0;
    win.__TAURI_INTERNALS__ = {
      transformCallback: (callback: (value: unknown) => void) => {
        const id = (callbacks += 1);
        win[`_${id}`] = callback;
        return id;
      },
      unregisterCallback: (id: number) => void delete win[`_${id}`],
      convertFileSrc: (path: string) => path,
      invoke: async (command: string, args: unknown, options: unknown) => {
        calls.push({ command, args: args instanceof Uint8Array ? { bytes: args.length, ...meta(options) } : args });
        const handler = commands[command];
        if (!handler) throw { kind: 'Io', message: `The mock shell has no command “${command}”.` };
        return (handler as (args: unknown, options?: unknown) => unknown)(args, options);
      },
    };

    const shell: ShellHandle = {
      agentResponse: (id) => agentResponses.get(id),
      holdGate: (hold) => void (gateHeld = hold),
      agentProgress: () => [...progressLog],
      addFile,
      file: (handle) => files.get(handle),
      nextOpen: (handle) => void (pickedOpen = handle),
      nextSaveAs: (target) => void (saveTarget = target),
      answer: (...choices) => void answers.push(...choices),
      cancelNextExport: () => void (cancelExport = true),
      trayArt: () => trayArt,
      seed: ({ recents: seeded = [], drafts = [], projects = [] }) => {
        for (const project of projects) {
          const handle = `p_${(handles += 1)}`;
          folders.set(handle, {
            info: { handle, name: project.name, displayPath: `~/work/${project.path ?? project.name}` },
            files: new Map(project.diagrams.map((diagram) => [diagram.path, { text: diagram.text, mtimeMs: Date.now() - diagram.ago }])),
          });
          listedProjects.push(handle);
        }
        for (const item of seeded) {
          const handle = addFile(item.name, item.text);
          const file = files.get(handle)!;
          recents.push({ handle, kind: 'file', name: file.name, displayPath: file.displayPath, lastOpenedMs: Date.now() - item.ago });
        }
        drafts.forEach((draft, i) => {
          const id = `q_0000000${i}-0000-4000-8000-000000000000`;
          recovery.set(id, {
            text: draft.text,
            entry: { id, title: draft.title, updatedAt: Date.now() - draft.ago, bytes: draft.text.length, origin: { kind: 'quick' } },
          });
        });
      },
      nextFolder: (name) => {
        pickedFolder = name === null ? null : ([...folders.values()].find((project) => project.info.name === name)?.info.handle ?? null);
      },
      emit,
      setUpdate: (snapshot) => {
        update = snapshot as Record<string, unknown>;
        emit({ type: 'update', snapshot });
      },
      calls: () => calls,
      exports: () => exported,
      recoveryIds: () => [...recovery.keys()],
      asked: () => asked,
    };
    win.__shell = shell;
  });
}
