import type { Handle } from '../api';
import type { DesktopController } from '../controller';
import type { DesktopState, FileTarget, ProjectState } from '../store';

/** What a file target is called, where it is now, and how it moves: shared by the Move dialog and a
 * tile dropped on a project, so both move the same file the same way. `null` when the open document
 * it named has closed since. */
export function resolveFileTarget(
  file: FileTarget,
  state: Pick<DesktopState, 'doc' | 'projects'>,
  controller: DesktopController,
): { name: string; fromPath: string; move: (project: Handle, keepBoth: boolean) => Promise<unknown> } | null {
  if (file.kind === 'open') {
    if (state.doc.kind !== 'file') return null;
    return {
      name: state.doc.name,
      fromPath: state.doc.displayPath,
      move: (project, keepBoth) => controller.moveOpenFile(project, { keepBoth }),
    };
  }
  if (file.kind === 'recent') {
    return {
      name: file.name,
      fromPath: file.displayPath,
      move: (project, keepBoth) => controller.moveFile(file.handle, file.displayPath, project, { keepBoth }),
    };
  }
  const source = state.projects.find((project) => project.info.handle === file.project);
  return {
    name: file.name,
    fromPath: `${source?.info.displayPath ?? ''}/${file.relPath}`,
    move: (project, keepBoth) => controller.moveProjectFile(file.project, file.relPath, project, { keepBoth }),
  };
}

/** The folder part of a display path, whichever separator the platform writes. */
export function folderOfPath(displayPath: string): string {
  const at = Math.max(displayPath.lastIndexOf('/'), displayPath.lastIndexOf('\\'));
  return at >= 0 ? displayPath.slice(0, at) : '';
}

/** The name Keep both will take, the way the shell picks it ("Checkout 2", "Checkout 3", …), from the
 * project's own listing. Only a preview: the shell picks again against the folder as it is then. */
export function nextFreeName(name: string, project: ProjectState): string {
  const taken = new Set(project.files.filter((file) => !file.relPath.includes('/')).map((file) => file.name.toLowerCase()));
  for (let n = 2; ; n += 1) {
    const candidate = `${name} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}
