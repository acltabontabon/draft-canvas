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
  /**
   * What an earlier session left behind, set before the app starts: recent files and unsaved drafts,
   * each `ago` milliseconds old.
   */
  seed(history: {
    recents?: { name: string; text: string; ago: number }[];
    drafts?: { title: string; text: string; ago: number }[];
    /** Project folders on the list, most recent first: each diagram by its path in the folder. */
    /** Folders on disk that have not been linked as projects. */
    explorer?: { name: string; path: string; diagrams: { path: string; text: string; ago: number }[] }[];
    projects?: { name: string; path?: string; diagrams: { path: string; text: string; ago: number }[] }[];
  }): void;
  failNextExplorer(message: string): void;
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
  /** Changes what the agent connector reports (connections, background support, a sidecar warning…);
   *  the page hears of it the way it would from the shell. */
  setAgent(patch: Record<string, unknown>): void;
  /** Seeds a proposal directly into the mock store, as if `submit_proposal` had already run. */
  addProposal(proposal: Record<string, unknown>): void;
  proposal(id: string): Record<string, unknown> | undefined;
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
      projects: listedProjects.map((handle) => {
        // The nearest other listed folder this one sits inside — the shell compares canonical roots;
        // the mock's display paths are the same shape, so a prefix test with a separator stands in.
        const path = folder(handle).info.displayPath;
        const within = listedProjects
          .filter((other) => other !== handle && path.startsWith(`${folder(other).info.displayPath}/`))
          .sort((a, b) => folder(b).info.displayPath.length - folder(a).info.displayPath.length)[0];
        return { ...folder(handle).info, agent: agentFolders.get(handle) ?? false, within: within ?? null };
      }),
    });
    let agentSettings: Record<string, unknown> = { enabled: false, listening: false, connections: 0, sidecarPath: '/Applications/Draft Canvas.app/Contents/MacOS/draft-canvas-mcp', sidecarWarning: null, background: 'restart-needed', projects: [] };
    // Claude Code without its CLI where the shell looks (so its manual command shows); Codex, Gemini CLI
    // and Junie not yet set up.
    const agentClients = new Map<string, Record<string, unknown>>([
      ['claude-code', { client: 'claude-code', state: 'not-set-up', automatic: false, location: '~/.claude.json', configuredCommand: null }],
      ['codex', { client: 'codex', state: 'not-set-up', automatic: true, location: '~/.codex/config.toml', configuredCommand: null }],
      ['gemini', { client: 'gemini', state: 'not-set-up', automatic: true, location: '~/.gemini/settings.json', configuredCommand: null }],
      ['junie', { client: 'junie', state: 'not-set-up', automatic: true, location: '~/.junie/mcp/mcp.json', configuredCommand: null }],
    ]);
    // The agent skill installed nowhere yet; install and remove flip it as `agent/skill.rs` would.
    const skillAt = (target: string) => (target === 'claude-code' ? '~/.claude/skills/draft-canvas' : '~/.agents/skills/draft-canvas');
    const agentSkills = new Map<string, Record<string, unknown>>(
      ['claude-code', 'agents'].map((target) => [target, { target, state: 'not-installed', location: skillAt(target), installedVersion: null, bundledVersion: '1', backup: null }]),
    );
    const proposals = new Map<string, Record<string, unknown>>();
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

    const createdFolders = new Set<string>();
    const explorerSessions = new Set<string>();
    const explorerPaths = new Map<string, string>();
    const explorerTokens = new Map<string, string>();
    let explorerFailure: string | null = null;
    const explorerLocation = (path: string) => {
      let handle = explorerTokens.get(path);
      if (!handle) { handle = `b_${++handles}`; explorerTokens.set(path, handle); explorerPaths.set(handle, path); }
      return { handle, name: path === '~' ? 'Home' : path.split('/').at(-1)!, displayPath: path };
    };
    const explorerTree = () => {
      const tree = new Map<string, { kind: 'folder' | 'file'; text?: string; mtimeMs: number }>();
      const add = (path: string, entry: { kind: 'folder' | 'file'; text?: string; mtimeMs: number }) => {
        tree.set(path, entry);
        let parent = path.slice(0, path.lastIndexOf('/'));
        while (parent) { if (!tree.has(parent)) tree.set(parent, { kind: 'folder', mtimeMs: 0 }); parent = parent.slice(0, parent.lastIndexOf('/')); }
      };
      for (const path of ['~', '~/Documents', '~/Downloads', '~/Desktop']) add(path, { kind: 'folder', mtimeMs: 0 });
      for (const path of createdFolders) add(path, { kind: 'folder', mtimeMs: Date.now() });
      for (const project of folders.values()) {
        add(project.info.displayPath, { kind: 'folder', mtimeMs: 0 });
        for (const [relPath, file] of project.files) add(`${project.info.displayPath}/${relPath}`, { kind: 'file', ...file });
      }
      for (const file of files.values()) add(file.displayPath, { kind: 'file', text: file.text, mtimeMs: Date.now() });
      return tree;
    };
    const explorerPath = (session: string, handle: string) => {
      const path = explorerPaths.get(handle);
      if (!explorerSessions.has(session) || !path) throw { kind: 'InvalidHandle', message: 'Reopen the explorer.' };
      return path;
    };
    const explorerList = (session: string, handle: string, showHidden: boolean, query: string, offset: number) => {
      const path = explorerPath(session, handle);
      if (explorerFailure) { const message = explorerFailure; explorerFailure = null; throw { kind: 'PermissionDenied', message }; }
      const tree = explorerTree();
      const entries = [...tree].filter(([item]) => item.startsWith(`${path}/`) && !item.slice(path.length + 1).includes('/'))
        .map(([item, entry]) => ({ ...explorerLocation(item), kind: entry.kind, modifiedMs: entry.mtimeMs, size: entry.text?.length ?? null }))
        .filter((item) => (showHidden || !item.name.startsWith('.')) && item.name.toLowerCase().includes(query.trim().toLowerCase()))
        .sort((a, b) => Number(a.kind !== 'folder') - Number(b.kind !== 'folder') || a.name.localeCompare(b.name));
      const crumbs = path.split('/').map((_, index, parts) => explorerLocation(parts.slice(0, index + 1).join('/')));
      return { location: explorerLocation(path), breadcrumbs: crumbs, entries: entries.slice(offset, offset + 200), total: entries.length, nextOffset: offset + 200 < entries.length ? offset + 200 : null, truncated: false };
    };

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
      explorer_open: (args: { startIn?: { projectHandle: string; relPath: string } }) => {
        const session = `x_${++handles}`;
        explorerSessions.add(session);
        const places = ['~', '~/Desktop', '~/Documents', '~/Downloads'].map((path) => ({ location: explorerLocation(path), project: false }));
        places.push(...listedProjects.map((handle) => ({ location: explorerLocation(folder(handle).info.displayPath), project: true })));
        const startPath = args?.startIn ? `${folder(args.startIn.projectHandle).info.displayPath}${args.startIn.relPath ? '/' + args.startIn.relPath : ''}` : '~';
        return { session, places, directory: explorerList(session, explorerLocation(startPath).handle, false, '', 0) };
      },
      explorer_list: (args: { session: string; handle: string; showHidden: boolean; query: string; offset: number }) => explorerList(args.session, args.handle, args.showHidden, args.query, args.offset),
      explorer_save_file: (bytes: unknown, options: unknown) => {
        const args = meta(options) as { session: string; handle: string; name: string; expectedStamp?: string; copySidecarFrom?: string };
        const parent = explorerPath(args.session, args.handle);
        if (explorerFailure) { const message = explorerFailure; explorerFailure = null; throw { kind: 'PermissionDenied', message }; }
        const name = args.name.trim().replace(/\.draftcanvas$/i, '');
        if (!name || /[/\\:*?"<>|\x00-\x1f]/.test(name)) throw { kind: 'InvalidPath', message: 'Choose a file name without slashes or special characters.' };
        const path = `${parent}/${name}.draftcanvas`;
        let match = [...files].find(([, file]) => file.displayPath === path);
        const tree = explorerTree();
        if (tree.get(path)?.kind === 'folder') throw { kind: 'AlreadyExists', message: 'That name belongs to a folder. Choose another file name.' };
        if (!match && tree.get(path)?.kind === 'file') {
          const handle = addFile(name, tree.get(path)!.text!);
          files.get(handle)!.displayPath = path;
          match = [handle, files.get(handle)!];
        }
        if (match && args.expectedStamp !== stamp(match[1])) return { outcome: 'exists', name: `${name}.draftcanvas`, stamp: stamp(match[1]) };
        const handle = match?.[0] ?? addFile(name, decode(bytes));
        const file = files.get(handle)!;
        file.displayPath = path;
        file.text = decode(bytes);
        if (match) file.version += 1;
        if (args.copySidecarFrom && sidecars.has(args.copySidecarFrom)) sidecars.set(handle, sidecars.get(args.copySidecarFrom)!);
        // Mirror the write into every linked or unlinked folder on the mock disk.
        for (const project of folders.values()) if (path.startsWith(`${project.info.displayPath}/`)) project.files.set(path.slice(project.info.displayPath.length + 1), { text: file.text, mtimeMs: Date.now() });
        touch(handle, file);
        return { outcome: 'saved', saved: { handle, name, displayPath: path, stamp: stamp(file) } };
      },
      explorer_create_folder: (args: { session: string; handle: string; name: string }) => {
        const parent = explorerPath(args.session, args.handle);
        if (explorerFailure) { const message = explorerFailure; explorerFailure = null; throw { kind: 'PermissionDenied', message }; }
        const name = args.name.trim();
        if (!name || name === '.' || name === '..' || /[/\\:*?"<>|\x00-\x1f]/.test(name) || name.endsWith('.')) throw { kind: 'InvalidPath', message: 'Use a folder name without slashes or special characters.' };
        const path = `${parent}/${name}`;
        if (explorerTree().has(path)) throw { kind: 'AlreadyExists', message: 'An item with that name already exists. Choose another folder name.' };
        createdFolders.add(path);
        return explorerLocation(path);
      },
      explorer_peek: (args: { session: string; handle: string }) => explorerTree().get(explorerPath(args.session, args.handle))?.text ?? null,
      explorer_add_project: (args: { session: string; handle: string }) => {
        const path = explorerPath(args.session, args.handle);
        let project = [...folders.values()].find((item) => item.info.displayPath === path);
        if (!project) {
          const handle = `p_${++handles}`;
          project = { info: { handle, name: explorerLocation(path).name, displayPath: path }, files: new Map([...explorerTree()].filter(([item, entry]) => item.startsWith(`${path}/`) && entry.kind === 'file').map(([item, entry]) => [item.slice(path.length + 1), { text: entry.text!, mtimeMs: entry.mtimeMs }])) };
          folders.set(handle, project);
        }
        toFront(project.info.handle);
        return project.info;
      },
      explorer_open_file: (args: { session: string; handle: string }) => {
        const path = explorerPath(args.session, args.handle);
        const text = explorerTree().get(path)?.text;
        if (text === undefined) throw { kind: 'NotFound', message: 'That diagram is no longer there.' };
        const handle = [...files].find(([, file]) => file.displayPath === path)?.[0] ?? addFile(stemOf(path), text);
        files.get(handle)!.displayPath = path;
        touch(handle, files.get(handle)!);
        return opened(handle, files.get(handle)!);
      },
      explorer_close: (args: { session: string }) => void explorerSessions.delete(args.session),
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
      agent_clients: () => [...agentClients.values()],
      agent_connect_client: (args: { client: string }) => {
        const setup = { ...agentClients.get(args.client)!, state: 'ready', configuredCommand: agentSettings.sidecarPath };
        agentClients.set(args.client, setup);
        return setup;
      },
      agent_skills: () => [...agentSkills.values()],
      agent_install_skill: (args: { target: string }) => {
        const setup = { ...agentSkills.get(args.target)!, state: 'ready', installedVersion: '1', backup: null };
        agentSkills.set(args.target, setup);
        return setup;
      },
      agent_remove_skill: (args: { target: string }) => {
        const setup = { ...agentSkills.get(args.target)!, state: 'not-installed', installedVersion: null, backup: null };
        agentSkills.set(args.target, setup);
        return setup;
      },
      // Proposal review — the mock's rules mirror `proposals.rs`/`commands/agent.rs` closely enough
      // for a browser-driven test of the review panel: idempotent resolve, wrong-stage refusal, and
      // the version/identity check `begin_accept` makes before any commit is attempted.
      agent_proposal_list: (args: { diagramId?: string }) =>
        [...proposals.values()]
          .filter((p) => args.diagramId === undefined || p.diagramId === args.diagramId)
          .sort((a, b) => (b.updatedAt as number) - (a.updatedAt as number)),
      agent_proposal_get: (args: { id: string }) => proposals.get(args.id) ?? null,
      agent_proposal_begin_accept: (args: { id: string; version: number; diagramId: string; path: string[] }) => {
        const proposal = proposals.get(args.id);
        if (!proposal) return { ok: false, code: 'NOT_FOUND' };
        if (proposal.status !== 'pending' && proposal.status !== 'accepting') return { ok: false, code: 'WRONG_STAGE', status: proposal.status };
        if (proposal.version !== args.version || proposal.diagramId !== args.diagramId || JSON.stringify(proposal.path) !== JSON.stringify(args.path)) {
          return { ok: false, code: 'PROPOSAL_CHANGED', proposal };
        }
        const next = { ...proposal, status: 'accepting' };
        proposals.set(args.id, next);
        return { ok: true, proposal: next };
      },
      agent_proposal_resolve: (args: { id: string; status: 'accepted' | 'rejected' | 'dismissed' }) => {
        const proposal = proposals.get(args.id);
        if (!proposal) return { ok: false, code: 'NOT_FOUND' };
        if (proposal.status === args.status) return { ok: true, proposal };
        const terminal = new Set(['accepted', 'rejected', 'dismissed', 'informational', 'accept-failed']);
        if (terminal.has(proposal.status as string)) return { ok: false, code: 'ALREADY_RESOLVED', status: proposal.status };
        const valid =
          (proposal.status === 'accepting' && (args.status === 'accepted' || args.status === 'dismissed')) ||
          (proposal.status === 'pending' && (args.status === 'rejected' || args.status === 'dismissed'));
        if (!valid) return { ok: false, code: 'WRONG_STAGE', status: proposal.status };
        const next = { ...proposal, status: args.status, resolvedAt: Date.now() };
        proposals.set(args.id, next);
        return { ok: true, proposal: next };
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
      setAgent: (patch) => {
        agentSettings = { ...agentSettings, ...patch };
        emit({ type: 'agent-changed' });
      },
      seed: ({ recents: seeded = [], drafts = [], projects = [], explorer = [] }) => {
        for (const project of [...projects, ...explorer]) {
          const handle = `p_${(handles += 1)}`;
          folders.set(handle, {
            info: { handle, name: project.name, displayPath: project.path?.startsWith('~/') ? project.path : `~/work/${project.path ?? project.name}` },
            files: new Map(project.diagrams.map((diagram) => [diagram.path, { text: diagram.text, mtimeMs: Date.now() - diagram.ago }])),
          });
          if (projects.includes(project)) listedProjects.push(handle);
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
      failNextExplorer: (message) => { explorerFailure = message; },
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
      addProposal: (proposal) => void proposals.set(proposal.proposalId as string, proposal),
      proposal: (id) => proposals.get(id),
    };
    win.__shell = shell;
  });
}
