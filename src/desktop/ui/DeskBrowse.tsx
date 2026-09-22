import { useDeferredValue, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '../../ui/common/Button';
import { Icon } from '../../ui/common/Icon';
import type { DesktopController } from '../controller';
import type { DesktopState, ProjectState } from '../store';
import { DocTile, type DocTileProps } from './DocTile';

export type BrowseScope = 'all' | 'unsaved' | 'recent' | { project: string };

export type BrowseTile = Omit<DocTileProps, 'index' | 'onHot' | 'onKeyDown'> & {
  description: string;
  /** What a search matches: the name, the folder it's in, the project. */
  haystack: string;
};

interface Group {
  id: string;
  title: string;
  /** One quiet line beside the title: where it is, how many. */
  meta?: string;
  tiles: BrowseTile[];
  /** Instead of tiles: why there are none. */
  empty?: ReactNode;
  actions?: ReactNode;
}

/** How many tiles a group shows before "Show all": a row or two in the overview, more in one scope. */
const OVERVIEW = 12;
const FOCUSED = 60;

/**
 * Everything the person has, in one place that stays usable at any size: every unsaved draft, recent
 * file and project, grouped, each diagram drawn as itself. A search finds any of them by name, folder
 * or project; the scopes narrow to one group. Groups start short and open on request, drawings are read
 * only as tiles come into view, and a project is listed only once this is open — so a list of fifty
 * projects and thousands of diagrams costs what's on screen.
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
  groupsFor: (state: DesktopState) => { unsaved: BrowseTile[]; recent: BrowseTile[]; project: (project: ProjectState) => BrowseTile[] };
  onClose: () => void;
  mac: boolean;
}) {
  const [scope, setScope] = useState<BrowseScope>(initialScope);
  const [query, setQuery] = useState('');
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const searchRef = useRef<HTMLInputElement>(null);
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());

  // Every project is listed once this opens (names and dates only), two folders at a time.
  const handles = state.projects.map((project) => project.info.handle).join('|');
  useEffect(() => {
    void controller.scanProjects(state.projects.map((project) => project.info.handle));
    // `handles` is what says the list changed.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, handles]);

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

  const make = groupsFor(state);
  const groups = ((): Group[] => {
    const list: Group[] = [];
    if (make.unsaved.length > 0) list.push({ id: 'unsaved', title: 'Drafts', meta: count(make.unsaved.length, 'draft'), tiles: make.unsaved });
    if (make.recent.length > 0) {
      list.push({
        id: 'recent',
        title: 'Recent',
        meta: count(make.recent.length, 'file'),
        tiles: make.recent,
        actions: (
          <Button variant="quiet" className="dc-browse-action" onClick={() => void controller.clearRecents()}>
            Clear recent
          </Button>
        ),
      });
    }
    for (const project of state.projects) {
      const handle = project.info.handle;
      const remove = (
        <Button variant="quiet" className="dc-browse-action" onClick={() => void controller.forgetProject(handle)}>
          Remove from Home
        </Button>
      );
      list.push({
        id: `project:${handle}`,
        title: project.info.name,
        meta:
          project.status === 'ready'
            ? `${project.info.displayPath} · ${count(project.files.length, 'diagram')}${project.truncated ? ' (some subfolders not listed)' : ''}`
            : project.info.displayPath,
        tiles: project.status === 'ready' ? make.project(project) : [],
        empty:
          project.status === 'missing' ? (
            <p className="dc-browse-empty">This folder isn’t there right now — on a drive that isn’t connected, or moved. It stays here until you remove it.</p>
          ) : project.status === 'ready' ? (
            <p className="dc-browse-empty">
              No diagrams here yet.{' '}
              <button type="button" className="dc-browse-link" onClick={() => void controller.newCanvasIn(handle)}>
                Start one
              </button>
            </p>
          ) : (
            <p className="dc-browse-empty" aria-busy="true">
              Listing…
            </p>
          ),
        actions:
          project.status === 'missing' ? (
            remove
          ) : (
            <>
              <Button variant="quiet" className="dc-browse-action" onClick={() => void controller.newCanvasIn(handle)}>
                New canvas here
              </Button>
              <Button variant="quiet" className="dc-browse-action" onClick={() => void controller.scanProjects([handle], { again: true })}>
                Refresh
              </Button>
              {remove}
            </>
          ),
      });
    }
    return list;
  })();

  const inScope = groups.filter((group) =>
    scope === 'all' ? true : typeof scope === 'string' ? group.id === scope : group.id === `project:${scope.project}`,
  );
  const searching = deferredQuery.length > 0;
  const shown = inScope
    .map((group) => {
      if (!searching) return group;
      const tiles = group.tiles.filter((tile) => tile.haystack.includes(deferredQuery));
      return { ...group, tiles, meta: `${tiles.length} of ${count(group.tiles.length, group.id === 'unsaved' ? 'draft' : group.id === 'recent' ? 'file' : 'diagram')}` };
    })
    .filter((group) => !searching || group.tiles.length > 0);
  const matches = shown.reduce((total, group) => total + group.tiles.length, 0);
  const limit = scope === 'all' && !searching ? OVERVIEW : FOCUSED;

  const scopes: { key: string; value: BrowseScope; label: string; count?: number }[] = [
    { key: 'all', value: 'all', label: 'Everything' },
    ...(make.unsaved.length > 0 ? [{ key: 'unsaved', value: 'unsaved' as const, label: 'Drafts', count: make.unsaved.length }] : []),
    ...(make.recent.length > 0 ? [{ key: 'recent', value: 'recent' as const, label: 'Recent', count: make.recent.length }] : []),
    ...state.projects.map((project) => ({
      key: `project:${project.info.handle}`,
      value: { project: project.info.handle },
      label: project.info.name,
      ...(project.status === 'ready' ? { count: project.files.length } : {}),
    })),
  ];
  const scopeKey = typeof scope === 'string' ? scope : `project:${scope.project}`;

  return (
    <section className="dc-browse" aria-label="Your diagrams">
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
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a diagram in every project"
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
              setOpened(new Set());
            }}
          >
            {option.label}
            {option.count !== undefined && <span className="dc-browse-count">{option.count}</span>}
          </button>
        ))}
      </nav>

      <div className="dc-browse-body">
        {searching && (
          <p className="dc-browse-summary" role="status">
            {matches === 0 ? `Nothing matches “${query.trim()}”.` : `${count(matches, 'diagram')} match “${query.trim()}”.`}
          </p>
        )}
        {!searching && shown.length === 0 && <p className="dc-browse-summary">Nothing here yet. Add a project, or start a Quick Draft.</p>}
        {shown.map((group) => {
          const open = opened.has(group.id);
          const visible = open ? group.tiles : group.tiles.slice(0, limit);
          return (
            <section key={group.id} className="dc-browse-group" aria-label={group.title}>
              <header className="dc-browse-group-head">
                <h2>{group.title}</h2>
                {group.meta && (
                  <span className="dc-browse-meta" title={group.meta}>
                    {group.meta}
                  </span>
                )}
                {group.actions && <span className="dc-browse-actions">{group.actions}</span>}
              </header>
              {group.tiles.length === 0 && !searching ? (
                group.empty
              ) : (
                <div className="dc-browse-grid">
                  {visible.map((tile, i) => {
                    const { haystack: _haystack, description: _description, ...props } = tile;
                    return <DocTile key={tile.entryKey} {...props} index={Math.min(i, 12)} />;
                  })}
                </div>
              )}
              {visible.length < group.tiles.length && (
                <button type="button" className="dc-browse-more" onClick={() => setOpened((known) => new Set(known).add(group.id))}>
                  Show all {group.tiles.length}
                </button>
              )}
            </section>
          );
        })}
      </div>
    </section>
  );
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
