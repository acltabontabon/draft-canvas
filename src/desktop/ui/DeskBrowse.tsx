import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '../../ui/common/Button';
import { Icon } from '../../ui/common/Icon';
import type { Handle } from '../api';
import { recallBrowse, rememberBrowse } from '../browseMemory';
import type { DesktopController } from '../controller';
import type { DesktopState, ProjectState } from '../store';
import { DocTile, type DocTileProps } from './DocTile';
import { childrenOf, descendantsOf, folderTile, projectTile } from './tiles';

export type BrowseScope = 'all' | 'unsaved' | 'recent' | { project: Handle; relPath: string };

export type BrowseTile = Omit<DocTileProps, 'index' | 'onHot' | 'onKeyDown'> & {
  description: string;
  /** What a search matches: the name, the folder it's in, the project. Empty for a folder tile, which
   * a search never matches directly — only what browsing into it would find. */
  haystack: string;
};

/** How many tiles show before "Show all": Everything, unsearched, is many groups' worth at once; every
 * other view is already just the one thing it's scoped to. */
const OVERVIEW = 12;
const FOCUSED = 60;

/**
 * Everywhere the person keeps a diagram, in one place that stays usable at any size: Everything (every
 * draft, recent file and project diagram, each shown once), Drafts, Recent, and — inside a project —
 * its folders, browsed one level at a time or searched all the way down. A search finds a diagram by
 * name, folder or project, always inside whatever scope is selected; Everything is the only scope that
 * reaches across every registered project, drafts and recents at once, and says so. Drawings are read
 * only as tiles come into view, and a project is scanned once, on open, however large it is.
 */
export function DeskBrowse({
  state,
  controller,
  scope: initialScope,
  groupsFor,
  onClose,
  mac,
}: {
  state: DesktopState;
  controller: DesktopController;
  scope: BrowseScope;
  groupsFor: (state: DesktopState) => { unsaved: BrowseTile[]; recent: BrowseTile[]; everything: BrowseTile[] };
  onClose: () => void;
  mac: boolean;
}) {
  const remembered = recallBrowse();
  const [scope, setScope] = useState<BrowseScope>(initialScope);
  const [query, setQuery] = useState(() => (scopesMatch(remembered?.scope, initialScope) ? remembered?.query ?? '' : ''));
  const [showAll, setShowAll] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  // `.dc-browse` doesn't scroll itself — `.dc-desk`, its ancestor, does (see `desktop.css`) — so
  // that's the element a scroll position is saved from and restored to.
  const rootRef = useRef<HTMLElement>(null);
  const scroller = () => rootRef.current?.closest<HTMLElement>('.dc-desk') ?? null;
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());

  // Every project is listed once this opens (names and dates only), two folders at a time.
  const handles = state.projects.map((project) => project.info.handle).join('|');
  useEffect(() => {
    void controller.scanProjects(state.projects.map((project) => project.info.handle));
    // `handles` is what says the list changed.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, handles]);

  // Where this was left, kept across the editor unmounting Browse entirely while a diagram is open.
  useEffect(() => {
    rememberBrowse({ scope, query, scrollTop: scroller()?.scrollTop ?? 0 });
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, query]);
  useLayoutEffect(() => {
    const element = scroller();
    if (element && scopesMatch(remembered?.scope, initialScope)) element.scrollTop = remembered?.scrollTop ?? 0;
    // Only ever the position this view opened at, not on every scroll.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Switching scope — a tab, a folder, a breadcrumb — is a new list; nothing carries a scroll
  // position into it. The restore above already placed this scope's, so skip its own first run.
  const settledScope = useRef(false);
  useLayoutEffect(() => {
    if (!settledScope.current) {
      settledScope.current = true;
      return;
    }
    const element = scroller();
    if (element) element.scrollTop = 0;
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);
  // `.dc-desk` is what actually scrolls; a native `scroll` event there doesn't bubble down to
  // anything inside `DeskBrowse`, so the position is tracked by listening on it directly.
  useEffect(() => {
    const element = scroller();
    if (!element) return;
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        rememberBrowse({ scope, query, scrollTop: element.scrollTop });
      });
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => element.removeEventListener('scroll', onScroll);
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, query]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"]')) return;
      const inSearch = event.target === searchRef.current;
      if ((event.key === 'f' && (mac ? event.metaKey : event.ctrlKey)) || (event.key === '/' && !inSearch && !(event.target instanceof HTMLInputElement))) {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        if (query) setQuery('');
        else onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mac, onClose, query]);

  // A pass over every diagram in every project — worth keeping off every keystroke and scroll frame,
  // which is otherwise all this recomputed for. `groupsFor` only changes identity when `state` does.
  const make = useMemo(() => groupsFor(state), [state, groupsFor]);
  const searching = deferredQuery.length > 0;
  const scoped = scopeInto(scope, state.projects);
  const openFolder = (relPath: string) => {
    if (typeof scope === 'string') return;
    setScope({ project: scope.project, relPath });
    setShowAll(false);
  };
  const view = viewFor(scope, scoped, make, deferredQuery, searching, controller, openFolder);

  const limit = scope === 'all' && !searching ? OVERVIEW : FOCUSED;
  const visible = showAll ? view.tiles : view.tiles.slice(0, limit);

  const scopes: { key: string; value: BrowseScope; label: string; count?: number }[] = [
    { key: 'all', value: 'all', label: 'Everything' },
    ...(make.unsaved.length > 0 ? [{ key: 'unsaved', value: 'unsaved' as const, label: 'Drafts', count: make.unsaved.length }] : []),
    ...(make.recent.length > 0 ? [{ key: 'recent', value: 'recent' as const, label: 'Recent', count: make.recent.length }] : []),
    ...state.projects.map((project) => ({
      key: `project:${project.info.handle}`,
      value: { project: project.info.handle, relPath: '' },
      label: project.info.name,
      ...(project.status === 'ready' ? { count: project.files.length } : {}),
    })),
  ];
  const scopeKey = typeof scope === 'string' ? scope : `project:${scope.project}`;

  return (
    <section className="dc-browse" aria-label="Your diagrams" ref={rootRef}>
      <header className="dc-browse-head">
        <button type="button" className="dc-browse-back" onClick={onClose} title="Back to Home (Esc)">
          <Icon name="back" size={14} />
          Home
        </button>
        <label className="dc-browse-search">
          <Icon name="search" size={15} />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setShowAll(false);
            }}
            placeholder={scope === 'all' ? 'Find a diagram in every project' : 'Find a diagram here'}
            aria-label="Find a diagram"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd aria-hidden="true">{mac ? '⌘F' : 'Ctrl+F'}</kbd>
        </label>
        <Button variant="quiet" icon="folder" className="dc-browse-add" onClick={() => void controller.pickProject()}>
          Add project…
        </Button>
      </header>

      <nav className="dc-browse-scopes" aria-label="Show">
        {scopes.map((option) => (
          <button
            key={option.key}
            type="button"
            className="dc-browse-scope"
            aria-pressed={option.key === scopeKey}
            onClick={() => {
              setScope(option.value);
              setShowAll(false);
            }}
          >
            {option.label}
            {option.count !== undefined && <span className="dc-browse-count">{option.count}</span>}
          </button>
        ))}
      </nav>

      {view.breadcrumbs && (
        <nav className="dc-browse-crumbs" aria-label="Folder">
          {view.breadcrumbs.map((crumb, i) => (
            <span key={i} className="dc-browse-crumb-item">
              {i > 0 && <Icon name="forward" size={11} />}
              {crumb.scope ? (
                <button type="button" className="dc-browse-crumb" onClick={() => crumb.scope && setScope(crumb.scope)}>
                  {crumb.label}
                </button>
              ) : (
                <span className="dc-browse-crumb dc-browse-crumb-current">{crumb.label}</span>
              )}
            </span>
          ))}
        </nav>
      )}

      <div className="dc-browse-body">
        {searching && (
          <p className="dc-browse-summary" role="status">
            {view.tiles.length === 0 ? `Nothing matches “${query.trim()}”.` : `${count(view.tiles.length, 'diagram')} match “${query.trim()}”.`}
          </p>
        )}
        {view.truncatedNote && <p className="dc-browse-note">{view.truncatedNote}</p>}
        <section className="dc-browse-group" aria-label={view.title}>
          <header className="dc-browse-group-head">
            <h2>{view.title}</h2>
            {view.meta && (
              <span className="dc-browse-meta" title={view.meta}>
                {view.meta}
              </span>
            )}
            {view.actions && <span className="dc-browse-actions">{view.actions}</span>}
          </header>
          {view.tiles.length === 0 && !searching ? (
            view.empty ?? <p className="dc-browse-summary">Nothing here yet. Add a project, or start a Quick Draft.</p>
          ) : (
            <div className="dc-browse-grid">
              {visible.map((tile, i) => {
                const { haystack: _haystack, description: _description, ...props } = tile;
                return <DocTile key={tile.entryKey} {...props} index={Math.min(i, 12)} />;
              })}
            </div>
          )}
          {visible.length < view.tiles.length && (
            <button type="button" className="dc-browse-more" onClick={() => setShowAll(true)}>
              Show all {view.tiles.length}
            </button>
          )}
        </section>
      </div>
    </section>
  );
}

function scopesMatch(a: BrowseScope | undefined, b: BrowseScope): boolean {
  if (a === undefined) return false;
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  return a.project === b.project && a.relPath === b.relPath;
}

function scopeInto(scope: BrowseScope, projects: ProjectState[]): ProjectState | undefined {
  if (typeof scope === 'string') return undefined;
  return projects.find((project) => project.info.handle === scope.project);
}

interface View {
  title: string;
  meta?: string;
  tiles: BrowseTile[];
  empty?: ReactNode;
  actions?: ReactNode;
  breadcrumbs?: { label: string; scope: BrowseScope | null }[];
  truncatedNote?: string;
}

function viewFor(
  scope: BrowseScope,
  project: ProjectState | undefined,
  make: { unsaved: BrowseTile[]; recent: BrowseTile[]; everything: BrowseTile[] },
  query: string,
  searching: boolean,
  controller: DesktopController,
  openFolder: (relPath: string) => void,
): View {
  const matches = (tile: BrowseTile) => tile.haystack.includes(query);

  if (scope === 'all') {
    const tiles = searching ? make.everything.filter(matches) : make.everything;
    return { title: 'Everything', meta: everythingMeta(make, searching, tiles.length), tiles };
  }
  if (scope === 'unsaved') {
    const tiles = searching ? make.unsaved.filter(matches) : make.unsaved;
    return { title: 'Drafts', meta: scopedMeta(make.unsaved.length, tiles.length, 'draft', searching), tiles };
  }
  if (scope === 'recent') {
    const tiles = searching ? make.recent.filter(matches) : make.recent;
    return {
      title: 'Recent',
      meta: scopedMeta(make.recent.length, tiles.length, 'file', searching),
      tiles,
      actions: (
        <Button variant="quiet" className="dc-browse-action" onClick={() => void controller.clearRecents()}>
          Clear recent
        </Button>
      ),
    };
  }

  // A project (root or a folder inside it).
  const { project: handle, relPath } = scope;
  const name = project?.info.name ?? 'Project';
  const segments = relPath ? relPath.split('/') : [];
  const breadcrumbs = [
    { label: name, scope: segments.length > 0 ? ({ project: handle, relPath: '' } as BrowseScope) : null },
    ...segments.map((segment, i) => ({
      label: segment,
      scope: i === segments.length - 1 ? null : ({ project: handle, relPath: segments.slice(0, i + 1).join('/') } as BrowseScope),
    })),
  ];
  const remove = project && (
    <Button variant="quiet" className="dc-browse-action" onClick={() => void controller.forgetProject(handle)}>
      Remove from Home
    </Button>
  );

  if (!project) {
    return { title: name, tiles: [], breadcrumbs, empty: <p className="dc-browse-empty">This project is no longer on the list.</p> };
  }
  if (project.status === 'missing') {
    return {
      title: name,
      tiles: [],
      breadcrumbs,
      actions: remove,
      empty: <p className="dc-browse-empty">This folder isn’t there right now — on a drive that isn’t connected, or moved. It stays here until you remove it.</p>,
    };
  }
  if (project.status !== 'ready') {
    return { title: name, tiles: [], breadcrumbs, empty: <p className="dc-browse-empty" aria-busy="true">Listing…</p> };
  }

  const newCanvasHere = (
    <Button variant="quiet" className="dc-browse-action" onClick={() => void controller.newCanvasIn(handle, relPath)}>
      New canvas here
    </Button>
  );
  const truncated = project.truncatedDirs.includes(relPath);
  const truncatedNote = truncated ? 'Some items in this folder aren’t shown — a very large folder is listed only in part.' : undefined;

  if (searching) {
    const tiles = descendantsOf(project.files, relPath)
      .map((file) => projectTile(file, project.info, controller))
      .filter(matches);
    return {
      title: name,
      meta: relPath ? `Searching ${relPath} and its subfolders` : 'Searching every subfolder',
      breadcrumbs,
      tiles,
      actions: (
        <>
          {newCanvasHere}
          {remove}
        </>
      ),
      truncatedNote,
    };
  }

  const { folders, files } = childrenOf(project.files, relPath);
  const tiles = [
    ...folders.map((childName) => folderTile(project.info, relPath, childName, () => openFolder(relPath ? `${relPath}/${childName}` : childName))),
    ...files.map((file) => projectTile(file, project.info, controller)),
  ];
  return {
    title: name,
    meta: `${project.info.displayPath} · ${count(project.files.length, 'diagram')}`,
    breadcrumbs,
    tiles,
    actions: (
      <>
        {newCanvasHere}
        <Button variant="quiet" className="dc-browse-action" onClick={() => void controller.scanProjects([handle], { again: true })}>
          Refresh
        </Button>
        {remove}
      </>
    ),
    empty:
      tiles.length === 0 ? (
        <p className="dc-browse-empty">
          No diagrams here yet.{' '}
          <button type="button" className="dc-browse-link" onClick={() => void controller.newCanvasIn(handle, relPath)}>
            Start one
          </button>
        </p>
      ) : undefined,
    truncatedNote,
  };
}

function everythingMeta(make: { unsaved: BrowseTile[]; recent: BrowseTile[]; everything: BrowseTile[] }, searching: boolean, shown: number): string {
  return searching ? `${count(shown, 'diagram')} of ${count(make.everything.length, 'diagram')}` : count(make.everything.length, 'diagram');
}

function scopedMeta(total: number, shown: number, noun: string, searching: boolean): string {
  return searching ? `${count(shown, noun)} of ${count(total, noun)}` : count(total, noun);
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
