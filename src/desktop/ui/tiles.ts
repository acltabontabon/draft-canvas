import { relativeTime } from '../../lib/relativeTime';
import type { ProjectFile, ProjectInfo, RecentItem, RecoveryEntry } from '../api';
import type { DesktopController } from '../controller';
import { desktopStore, type DesktopState, type ProjectState } from '../store';
import type { BrowseTile } from './DeskBrowse';

/** Tile-building shared by Home's row and the browse view, so each diagram looks the same in both. */

export function folderOf(file: ProjectFile): string {
  return file.relPath.includes('/') ? file.relPath.slice(0, file.relPath.lastIndexOf('/')) : '';
}

export function draftTile(entry: RecoveryEntry, controller: DesktopController): BrowseTile {
  const fromFile = entry.origin.kind === 'file';
  const name = entry.origin.kind === 'file' ? entry.origin.name : entry.title;
  const when = relativeTime(entry.updatedAt);
  return {
    entryKey: `draft:${entry.id}`,
    kind: 'document',
    name,
    // Changes to a file were left unsaved when the app closed without asking: that one is a warning.
    meta: fromFile ? `Unsaved changes · ${when}` : when,
    edited: true,
    label: fromFile ? `Recover unsaved changes to ${name}` : `Open ${name}, a draft not saved to a file`,
    description: fromFile ? `Changes to ${name} that were never saved · ${when}` : `Saved locally, not to a file · ${when}`,
    haystack: name.toLowerCase(),
    thumbnail: { key: `draft:${entry.id}:${entry.updatedAt}`, load: () => controller.peek({ kind: 'draft', id: entry.id }) },
    onOpen: () => void controller.recover(entry.id),
    action: { label: `Discard ${name}`, icon: 'trash', run: () => void controller.discardRecovery(entry.id) },
  };
}

export function recentTile(item: RecentItem, controller: DesktopController): BrowseTile {
  return {
    entryKey: `recent:${item.handle}`,
    kind: 'document',
    name: item.name,
    meta: relativeTime(item.lastOpenedMs),
    label: `Open ${item.name}`,
    description: `${item.displayPath} · opened ${relativeTime(item.lastOpenedMs)}`,
    haystack: `${item.name} ${item.displayPath}`.toLowerCase(),
    thumbnail: { key: `${item.displayPath}:${item.lastOpenedMs}`, load: () => controller.peek({ kind: 'recent', handle: item.handle }) },
    onOpen: () => void controller.openHandle(item.handle),
    action: { label: `Remove ${item.name} from Recent`, icon: 'close', run: () => void controller.forgetRecent(item.handle) },
    secondaryAction: {
      label: `Rename ${item.name}…`,
      icon: 'pencil',
      run: () => desktopStore.update({ renameTarget: { kind: 'recent', handle: item.handle, name: item.name } }),
    },
  };
}

export function projectTile(file: ProjectFile, project: ProjectInfo, controller: DesktopController): BrowseTile {
  const key = `project:${project.handle}:${file.relPath}`;
  const folder = folderOf(file);
  return {
    entryKey: key,
    kind: 'document',
    name: file.name,
    meta: folder ? `${folder} · ${relativeTime(file.mtimeMs)}` : relativeTime(file.mtimeMs),
    label: `Open ${file.name}`,
    description: `${folder || project.name} · edited ${relativeTime(file.mtimeMs)}`,
    haystack: `${file.relPath} ${project.name}`.toLowerCase(),
    thumbnail: { key: `${key}:${file.mtimeMs}:${file.size}`, load: () => controller.peek({ kind: 'project', project: project.handle, relPath: file.relPath }) },
    onOpen: () => void controller.openProjectFile(project.handle, file.relPath),
    secondaryAction: {
      label: `Rename ${file.name}…`,
      icon: 'pencil',
      run: () => desktopStore.update({ renameTarget: { kind: 'project', project: project.handle, relPath: file.relPath, name: file.name } }),
    },
  };
}

/**
 * The immediate children of a folder inside a project's already-scanned files: subfolders to browse
 * into (named once each, however many files they hold), and the files directly inside it. Cheap — one
 * pass over an array already in memory from the project's own scan, so opening a folder costs nothing
 * new to fetch.
 */
export function childrenOf(files: ProjectFile[], relPath: string): { folders: string[]; files: ProjectFile[] } {
  const prefix = relPath ? `${relPath}/` : '';
  const folders = new Set<string>();
  const immediate: ProjectFile[] = [];
  for (const file of files) {
    if (!file.relPath.startsWith(prefix)) continue;
    const rest = file.relPath.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) immediate.push(file);
    else folders.add(rest.slice(0, slash));
  }
  return {
    folders: [...folders].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })),
    files: immediate,
  };
}

/** Every file at or below a folder: what a search inside that folder covers, descending automatically.
 * Browsing it (no search) uses `childrenOf` instead, which stops at the folder's own contents. An empty
 * `relPath` is the whole project. */
export function descendantsOf(files: ProjectFile[], relPath: string): ProjectFile[] {
  if (!relPath) return files;
  const prefix = `${relPath}/`;
  return files.filter((file) => file.relPath.startsWith(prefix));
}

export function folderTile(project: ProjectInfo, relPath: string, name: string, onOpen: () => void): BrowseTile {
  const full = relPath ? `${relPath}/${name}` : name;
  return {
    entryKey: `folder:${project.handle}:${full}`,
    kind: 'folder',
    name,
    label: `Open the ${name} folder`,
    description: `${project.name} / ${full}`,
    // Folders aren't themselves a search result — only what's browsed to reach them.
    haystack: '',
    onOpen,
  };
}

function inAnyRegisteredProject(item: RecentItem, projects: ProjectState[]): boolean {
  return projects.some(
    (project) =>
      project.status === 'ready' &&
      (item.displayPath === project.info.displayPath || item.displayPath.startsWith(`${project.info.displayPath}/`)),
  );
}

/**
 * Every draft, recent file and project diagram, once each — the "Everything" scope's whole point. A
 * file that is both a Recent entry and inside a registered (already-scanned) project shows only as the
 * project's own tile, which carries strictly more: its folder. A Recent file outside any registered
 * project, or inside one not yet scanned, still shows under its Recent tile — nothing to prefer it over.
 */
export function everythingTiles(state: DesktopState, controller: DesktopController): BrowseTile[] {
  interface Ranked {
    when: number;
    tile: BrowseTile;
  }
  const fromDrafts: Ranked[] = state.recovery.map((entry) => ({ when: entry.updatedAt, tile: draftTile(entry, controller) }));
  const fromProjects: Ranked[] = state.projects
    .filter((project) => project.status === 'ready')
    .flatMap((project) => project.files.map((file) => ({ when: file.mtimeMs, tile: projectTile(file, project.info, controller) })));
  const fromRecent: Ranked[] = state.recents
    .filter((item) => item.kind === 'file' && !inAnyRegisteredProject(item, state.projects))
    .map((item) => ({ when: item.lastOpenedMs, tile: recentTile(item, controller) }));
  return [...fromDrafts, ...fromProjects, ...fromRecent].sort((a, b) => b.when - a.when).map((ranked) => ranked.tile);
}
