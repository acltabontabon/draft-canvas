import type { DraftSummary, Project } from '../../document/types';

export type LibrarySort = 'updatedAt' | 'createdAt' | 'name';

/** Mirrors `uiStore`'s `libraryView` shape — the homepage sidebar's current selection. */
export interface LibraryView {
  kind: 'recent' | 'all' | 'unorganized' | 'project';
  projectId?: string;
}

/**
 * Search-first, organization-second: a non-empty query searches the whole
 * library regardless of the selected sidebar view, matching canvas title or
 * the name of the project a canvas belongs to. Purely client-side over data
 * already in memory — no new storage reads.
 *
 * Deliberately title/project-name only for now. Matching element, connector,
 * note, or attachment text would require the full, decrypted `DraftDocument`
 * bodies, which the plaintext `documents`/`DraftSummary` store never holds —
 * that's the encryption-at-rest boundary `IndexedDbRepository.ts` already
 * establishes. (The summary's `shape` is the one body-derived field, and it
 * is silhouettes only — kinds and boxes, no words — so there is nothing in it
 * to search.) A future pass could add an in-memory, non-persisted index built
 * by decrypting bodies lazily or in a background sweep, rebuilt each session
 * and never written back to the plaintext store.
 */
export function visibleCanvases(
  library: DraftSummary[],
  projects: Project[],
  view: LibraryView,
  searchQuery: string,
  sort: LibrarySort,
): DraftSummary[] {
  const query = searchQuery.trim().toLowerCase();
  const searching = query.length > 0;

  let base = library;
  if (!searching) {
    // A `projectId` naming a project that no longer exists (its delete could not
    // reach every member, or another tab removed it) is Unorganized — otherwise
    // that canvas would be listed nowhere but "All" and "Recent".
    if (view.kind === 'unorganized') {
      const known = new Set(projects.map((project) => project.id));
      base = base.filter((entry) => !entry.projectId || !known.has(entry.projectId));
    } else if (view.kind === 'project') base = base.filter((entry) => entry.projectId === view.projectId);
  } else {
    const matchingProjectIds = new Set(
      projects.filter((project) => project.name.toLowerCase().includes(query)).map((project) => project.id),
    );
    base = base.filter(
      (entry) =>
        entry.title.toLowerCase().includes(query) ||
        (entry.projectId !== undefined && matchingProjectIds.has(entry.projectId)),
    );
  }

  // "Recently edited" is a pinned shortcut, not a sort preference — it always
  // shows last-edited-first regardless of `sort`, unlike "All diagrams".
  const effectiveSort: LibrarySort = !searching && view.kind === 'recent' ? 'updatedAt' : sort;
  return [...base].sort((a, b) => {
    if (effectiveSort === 'name') return a.title.localeCompare(b.title);
    if (effectiveSort === 'createdAt') return b.createdAt - a.createdAt;
    return b.updatedAt - a.updatedAt;
  });
}

export function headingFor(view: LibraryView, projects: Project[], searching: boolean): string {
  if (searching) return 'Search results';
  switch (view.kind) {
    case 'all':
      return 'All diagrams';
    case 'unorganized':
      return 'Unorganized';
    case 'project':
      return projects.find((project) => project.id === view.projectId)?.name ?? 'Project';
    default:
      return 'Recently edited';
  }
}
