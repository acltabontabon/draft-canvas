import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { isImeKeyEvent } from '../../lib/isEditableTarget';
import { relativeTime } from '../../lib/relativeTime';
import { Button } from '../../ui/common/Button';
import { Icon } from '../../ui/common/Icon';
import { LibraryBrand } from '../../ui/Library/LibraryBrand';
import { LivingCanvas } from '../../ui/Library/LivingCanvas';
import type { ProjectFile } from '../api';
import { recallBrowse } from '../browseMemory';
import { desktopStore } from '../store';
import type { DesktopController } from '../controller';
import type { DesktopState, ProjectState } from '../store';
import { useDesktopController, useDesktopState } from '../useDesktop';
import { DeskBrowse, type BrowseScope, type BrowseTile } from './DeskBrowse';
import { DocTile } from './DocTile';
import { warmExplorer } from './DesktopExplorer';
import { draftTile, everythingTiles, recentTile } from './tiles';
import { UpdateChip } from './Updates';
import './desktop.css';

const SHELF_GAP = 20;
const TILE_WIDTH = 210;
/** However wide the window, one row stays one glance. */
const MAX_TILES = 5;

type TileSpec = BrowseTile;

/** One thing the shelf can show: the drafts, the recent files, the open projects. */
interface Source {
  id: string;
  label: string;
  tiles: TileSpec[];
  /** The shelf header's link into the complete library view. */
  more?: { label: string; description: string; run: () => void };
  /** A line of the source's own actions, under the previews. */
  aside?: ReactNode;
  /** What the row says when there is nothing in it. */
  empty?: string;
}

/**
 * The shared Living Canvas scene, with native file actions and a row of the person's own work.
 * Drafts and Recent appear while they have work; Projects stays discoverable before a folder is linked.
 *
 * It knows names and dates first. A file's drawing is read only once its tile is on screen, a
 * handful at a time, and never through anything that would count as opening it.
 */
export function DesktopHome() {
  const state = useDesktopState();
  const controller = useDesktopController();
  const rootRef = useRef<HTMLDivElement>(null);
  const shelfRef = useRef<HTMLElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const mac = state.platform !== 'windows' && state.platform !== 'linux';
  const returning = hasWork(state);
  const hasDiagrams = state.recovery.length > 0 || state.recents.some((item) => item.kind === 'file') || state.projects.some((project) => project.files.length > 0);

  const setAddingProject = (open: boolean) => desktopStore.update({ explorerMode: open ? 'project' : null });
  const [activeId, setActiveId] = useState<string | null>(null);
  // Reopening Browse (after a diagram closed and Home remounted) lands back where it was left.
  const [browse, setBrowse] = useState<BrowseScope | null>(() => recallBrowse()?.scope ?? null);
  // Browsing unmounts the shelf; coming back is a new one to measure and observe.
  const capacity = useCapacity(shelfRef, TILE_WIDTH, browse !== null || !state.listed);

  const sources = sourcesFor(state, controller, {
    showAll: (scope) => setBrowse(scope),
  });
  const showTabs = sources.length > 1;
  // Keep the chosen source while it exists; when its last item is removed, choose the next with work.
  const active = sources.find((source) => source.id === activeId) ?? sources.find((source) => source.tiles.length > 0) ?? sources[0];

  // Every slot is a real preview. The library link lives in the shelf header, so a stack of sheets
  // never competes with the person's drawings or takes their last preview's place.
  const room = Math.max(1, capacity);
  const shown = active ? active.tiles.slice(0, room) : [];

  // The projects in the row are listed (names and dates) so their stacks can be drawn; the rest wait.
  const rowProjects = active?.id === 'projects' ? shown.map((tile) => tile.entryKey.slice('projects:'.length)).join('|') : '';
  useEffect(() => {
    if (rowProjects) void controller.scanProjects(rowProjects.split('|'));
  }, [controller, rowProjects]);

  // Enter on an otherwise unfocused page starts drawing; ⌘F finds a diagram in everything.
  useEffect(() => {
    if (browse) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (hasDiagrams && event.key === 'f' && (mac ? event.metaKey : event.ctrlKey) && !document.querySelector('[role="dialog"]')) {
        event.preventDefault();
        setBrowse('all');
        requestAnimationFrame(() => rootRef.current?.querySelector<HTMLInputElement>('.dc-browse-search input')?.focus());
        return;
      }
      if (event.key !== 'Enter' || event.repeat || event.defaultPrevented || isImeKeyEvent(event)) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (event.target !== document.body && event.target !== document.documentElement) return;
      if (document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      void controller.newQuickDraft();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [controller, browse, mac, hasDiagrams]);

  const choose = (id: string) => {
    setActiveId(id);
  };

  /** ←/→ walk the row; ↑ goes back to the label that chose it. */
  const onTileKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const tiles = [...(rowRef.current?.querySelectorAll<HTMLButtonElement>('.dc-starter') ?? [])];
    const at = tiles.indexOf(event.currentTarget);
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      const next = tiles[at + (event.key === 'ArrowRight' ? 1 : -1)];
      if (!next) return;
      event.preventDefault();
      next.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      const tab = rootRef.current?.querySelector<HTMLButtonElement>('.dc-desk-label [aria-selected="true"]');
      (tab ?? actionRef.current)?.focus();
    }
  };

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      const next = sources[index + (event.key === 'ArrowRight' ? 1 : -1)];
      if (!next) return;
      event.preventDefault();
      choose(next.id);
      requestAnimationFrame(() => rootRef.current?.querySelector<HTMLButtonElement>(`[data-source="${next.id}"]`)?.focus());
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      rowRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      actionRef.current?.focus();
    }
  };

  if (browse) {
    return (
      <div className="dc-desk" ref={rootRef} data-browsing="">
        <div className="dc-desk-canvas" aria-hidden="true" />
        <UpdateChip placement="home" />
        <DeskBrowse
          state={state}
          controller={controller}
          scope={browse}
          groupsFor={(current) => groupsFor(current, controller)}
          onClose={() => setBrowse(null)}
          onAddProject={() => setAddingProject(true)}
          mac={mac}
        />
      </div>
    );
  }

  const empty = active && active.tiles.length === 0 ? active.empty : undefined;

  return (
    <div
      className="dc-desk"
      ref={rootRef}
      data-mode={!state.listed ? 'pending' : returning ? 'returning' : 'first'}
    >
      <div className="dc-desk-canvas" aria-hidden="true" />
      <header className="dc-desk-top">
        <LibraryBrand />
        <div className="dc-desk-top-actions">
          <UpdateChip placement="home" />
          {hasDiagrams && <Button variant="quiet" icon="search" title={`Find a diagram (${chord(mac, 'F')})`} aria-label="Find a diagram" onClick={() => setBrowse('all')} />}
        </div>
      </header>

      <main className="dc-desk-stage">
        {/* Nothing is drawn until Home knows whether this is a first run: then the right hero arrives once. */}
        {state.listed && (
          <>
            <LivingCanvas
              start={
                <button
                  ref={actionRef}
                  type="button"
                  className="dc-living-primary"
                  aria-label="New Quick Draft"
                  aria-describedby="dc-desk-action-hint"
                  aria-keyshortcuts={mac ? 'Meta+N' : 'Control+N'}
                  onClick={() => void controller.newQuickDraft()}
                  onKeyDown={(event) => {
                    if (event.key !== 'ArrowDown') return;
                    event.preventDefault();
                    (rootRef.current?.querySelector<HTMLButtonElement>('.dc-desk-label [aria-selected="true"]') ??
                      rowRef.current?.querySelector<HTMLButtonElement>('button'))?.focus();
                  }}
                >
                  <Icon name="plus" size={16} />
                  <span className="dc-living-primary-text">
                    <span className="dc-living-primary-name">Quick Draft</span>
                    <span className="dc-living-primary-hint" id="dc-desk-action-hint">
                      No title needed. Just begin.
                    </span>
                  </span>
                  <kbd aria-hidden="true">{chord(mac, 'N')}</kbd>
                </button>
              }
              example={<Button variant="quiet" icon="flow" onClick={() => void controller.newQuickDraft('order-processing')}>Try an example</Button>}
              open={<Button variant="quiet" icon="upload" onPointerEnter={warmExplorer} onFocus={warmExplorer} onClick={() => void controller.openFile()}>Open file…</Button>}
              companion={
                <Button variant="quiet" icon="agent" onClick={() => desktopStore.update({ settingsOpen: true, settingsCategory: 'agents' })}>
                  Connect an agent…
                </Button>
              }
            />

            <section className="dc-desk-shelf" ref={shelfRef} aria-label="Your sketch shelf">
              <header className="dc-desk-shelf-head">
                {showTabs && <div className="dc-desk-label">
                  <div role="tablist" aria-label="Show">
                    {sources.map((source, i) => (
                      <button
                        key={source.id}
                        type="button"
                        role="tab"
                        id={`dc-desk-tab-${source.id}`}
                        data-source={source.id}
                        aria-selected={source.id === active?.id}
                        aria-controls="dc-desk-row"
                        tabIndex={source.id === active?.id ? 0 : -1}
                        onClick={() => choose(source.id)}
                        onKeyDown={(event) => onTabKey(event, i)}
                      >
                        {source.label}
                      </button>
                    ))}
                  </div>
                </div>}
                <div className="dc-desk-shelf-actions">
                  {active?.id === 'projects' && active.tiles.length > 0 && (
                    <Button variant="quiet" icon="plus" className="dc-desk-project-add" onPointerEnter={warmExplorer} onFocus={warmExplorer} onClick={() => setAddingProject(true)}>Add project…</Button>
                  )}
                  {active?.more && active.tiles.length > 0 && (
                    <button
                      type="button"
                      className="dc-desk-view-all"
                      aria-label={active.more.label}
                      title={active.more.description}
                      onClick={active.more.run}
                    >
                      View all <span>{active.tiles.length}</span><Icon name="forward" size={13} />
                    </button>
                  )}
                </div>
              </header>

              <div
                className="dc-desk-row"
                id="dc-desk-row"
                ref={rowRef}
                data-source={active?.id}
                style={{ '--shelf-columns': capacity } as CSSProperties}
                role={showTabs ? 'tabpanel' : 'group'}
                aria-labelledby={showTabs ? `dc-desk-tab-${active?.id}` : undefined}
                aria-label={showTabs ? undefined : active?.label}
              >
                {shown.map((tile, i) => (
                  <DocTile
                    key={`${active!.id}:${tile.entryKey}`}
                    {...tile}
                    shelf
                    index={i}
                    onKeyDown={onTileKey}
                  />
                ))}
                {empty && (
                  <div className={active!.id === 'projects' ? 'dc-desk-project-welcome' : 'dc-desk-empty'} key={`${active!.id}:empty`}>
                    {active!.id === 'projects' ? (
                      <>
                        <span className="dc-desk-project-art" aria-hidden="true"><Icon name="folder" size={56} /></span>
                        <div><h2>A home for related ideas.</h2><p>{empty}</p></div>
                        <Button variant="quiet" icon="plus" className="dc-desk-project-add" onPointerEnter={warmExplorer} onFocus={warmExplorer} onClick={() => setAddingProject(true)}>Add project…</Button>
                      </>
                    ) : empty}
                  </div>
                )}
              </div>

              {active?.aside && active.tiles.length > 0 && <div className="dc-desk-aside">{active.aside}</div>}
            </section>
          </>
        )}
      </main>
    </div>
  );
}

/** There is something to come back to: a draft, a file opened before, a project. */
function hasWork(state: DesktopState): boolean {
  return state.recovery.length > 0 || state.projects.length > 0 || state.recents.some((item) => item.kind === 'file');
}

function useCapacity(shelfRef: RefObject<HTMLElement | null>, minimumWidth: number, away: boolean): number {
  const [capacity, setCapacity] = useState(MAX_TILES);
  useLayoutEffect(() => {
    const shelf = shelfRef.current;
    if (away || !shelf || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const fit = Math.floor((shelf.clientWidth + SHELF_GAP) / (minimumWidth + SHELF_GAP));
      setCapacity(Math.max(1, Math.min(MAX_TILES, fit)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(shelf);
    return () => observer.disconnect();
  }, [shelfRef, minimumWidth, away]);
  return capacity;
}

/** A shortcut the way the platform writes one: ⇧⌘N on a Mac, Ctrl+Shift+N elsewhere. */
function chord(mac: boolean, key: string, shift = false): string {
  if (mac) return `${shift ? '⇧' : ''}⌘${key}`;
  return `Ctrl+${shift ? 'Shift+' : ''}${key}`;
}

/**
 * Everything Home can point at, most pressing first: the drafts, what was open, and the projects.
 * The Projects row shows the most recent, and View all opens every one in the browse view.
 * Projects stays visible when empty; Drafts and Recent appear only while they contain work.
 */
function sourcesFor(
  state: DesktopState,
  controller: DesktopController,
  { showAll }: { showAll: (scope: BrowseScope) => void },
): Source[] {
  const sources: Source[] = [];
  // Home's row never shows "Everything" — only Browse does — so this skips building it (it costs a
  // pass over every diagram in every project, which a returning-home render pays for on its own).
  const unsaved = state.recovery.map((entry) => draftTile(entry, controller));
  const recent = state.recents.filter((item) => item.kind === 'file').map((item) => recentTile(item, controller));

  if (unsaved.length > 0) {
    sources.push({
      id: 'unsaved',
      label: 'Drafts',
      tiles: unsaved,
      more: { label: `All ${unsaved.length}`, description: 'Every draft not saved to a file yet', run: () => showAll('unsaved') },
    });
  }

  if (recent.length > 0) {
    sources.push({
      id: 'recent',
      label: 'Recent',
      tiles: recent,
      more: { label: `All ${recent.length}`, description: 'Everything opened lately', run: () => showAll('recent') },
      aside: (
        <Button variant="quiet" className="dc-desk-aside-action" onClick={() => void controller.clearRecents()}>
          Clear recent
        </Button>
      ),
    });
  }

  sources.push({
    id: 'projects',
    label: 'Projects',
    empty: 'Link a folder to keep diagrams together as a project.',
    tiles: state.projects.map((project) => projectCard(project, () => showAll({ project: project.info.handle, relPath: '' }), controller)),
    more: {
      label: `All ${state.projects.length}`,
      description: `Every project, and every diagram in them`,
      run: () => showAll('all'),
    },
  });

  return sources;
}

/** The tiles for every group, shared by Home's row and the browse view so each diagram looks the same in both. */
function groupsFor(state: DesktopState, controller: DesktopController) {
  return {
    unsaved: state.recovery.map((entry) => draftTile(entry, controller)),
    // Projects have their own list now; a Recent written by an earlier version may still name some.
    recent: state.recents.filter((item) => item.kind === 'file').map((item) => recentTile(item, controller)),
    everything: everythingTiles(state, controller),
  };
}

/** A project in Home's row: a stack of its diagrams, the newest drawn on top; it opens in the browse view. */
function projectCard(project: ProjectState, open: () => void, controller: DesktopController): TileSpec {
  const { info } = project;
  const newest = project.files.reduce<ProjectFile | null>((best, file) => (!best || file.mtimeMs > best.mtimeMs ? file : best), null);
  const meta =
    project.status === 'missing'
      ? 'Not found'
      : project.status !== 'ready'
        ? ' '
        : newest
          ? `${project.files.length} ${project.files.length === 1 ? 'diagram' : 'diagrams'} · ${relativeTime(newest.mtimeMs)}`
          : 'No diagrams yet';
  return {
    entryKey: `projects:${info.handle}`,
    kind: 'project',
    stack: project.files.length,
    missing: project.status === 'missing',
    name: info.name,
    meta,
    label: `Show the ${info.name} project`,
    description: project.status === 'missing' ? `${info.displayPath} isn’t there right now` : info.displayPath,
    haystack: info.name.toLowerCase(),
    ...(newest
      ? {
          thumbnail: {
            key: `project:${info.handle}:${newest.relPath}:${newest.mtimeMs}:${newest.size}`,
            load: () => controller.peek({ kind: 'project', project: info.handle, relPath: newest.relPath }),
          },
        }
      : {}),
    onOpen: open,
  };
}
