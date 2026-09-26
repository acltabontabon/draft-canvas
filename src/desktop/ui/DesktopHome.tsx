import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { isImeKeyEvent } from '../../lib/isEditableTarget';
import { relativeTime } from '../../lib/relativeTime';
import { PRODUCT } from '../../product';
import type { ArchitectureStarter } from '../../starters';
import { Button } from '../../ui/common/Button';
import { Icon } from '../../ui/common/Icon';
import { LibraryBrand } from '../../ui/Library/LibraryBrand';
import { starterShape } from '../../ui/Library/starterShapes';
import { useStarters } from '../../ui/Library/useStarters';
import type { ProjectFile } from '../api';
import { recallBrowse } from '../browseMemory';
import { desktopStore } from '../store';
import type { DesktopController } from '../controller';
import type { DesktopState, ProjectState } from '../store';
import { useDesktopController, useDesktopState } from '../useDesktop';
import { DeskBrowse, type BrowseScope, type BrowseTile } from './DeskBrowse';
import { DocTile } from './DocTile';
import { draftTile, everythingTiles, recentTile } from './tiles';
import { UpdateChip } from './Updates';
import './desktop.css';

/** A tile's drawing is 144px wide at scale 1; the row keeps this much air between them. */
const TILE = 144;
const GAP = { first: 36, returning: 28 } as const;
/**
 * How large a tile draws. Someone coming back is choosing between their own diagrams, so the drawings
 * are big enough to tell apart; a first run shows starters, which read at the smaller size.
 */
const SCALE = { first: 1.15, returning: 1.36 } as const;
/** However wide the window, one row stays one glance. */
const MAX_TILES = 6;

type TileSpec = BrowseTile;

/** One thing the fan can point at: the drafts, the recent files, the open project, the starters. */
interface Source {
  id: string;
  label: string;
  tiles: TileSpec[];
  /** What the row's last tile does when there are more than fit: show them all, or browse starters. */
  more?: { label: string; description: string; run: () => void };
  /** A line of the source's own actions, under the readout. */
  aside?: ReactNode;
  /** What the readout says while nothing is under the pointer: what this row is. */
  note: string;
  /** What the row says when there is nothing in it. */
  empty?: string;
}

/**
 * Where the desktop app opens — and it is itself a diagram, drawn in the app's own hand. The motto
 * is a text node, just placed and still selected; a connector runs from it into the one thing to do,
 * Quick Draft; and from there a single bus fans out to a row of the person's own work, each file
 * drawn as the diagram it is. The bus's label is where the row is chosen, the way a connector on the
 * canvas carries a label: Drafts, Recent, Projects, Starters.
 *
 * A first run gets the motto at full size over a row of starters. Once there is work to come back
 * to, the motto steps down to one line and the row — drawn larger — moves up under the action.
 * Which of the two is decided only once recents and drafts are listed, so neither flashes first.
 *
 * It knows names and dates first. A file's drawing is read only once its tile is on screen, a
 * handful at a time, and never through anything that would count as opening it.
 */
export function DesktopHome() {
  const state = useDesktopState();
  const controller = useDesktopController();
  const catalog = useStarters();
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const mac = state.platform !== 'windows' && state.platform !== 'linux';
  const returning = hasWork(state);
  const scale = returning ? SCALE.returning : SCALE.first;
  const gap = returning ? GAP.returning : GAP.first;

  const [activeId, setActiveId] = useState<string | null>(null);
  const [hot, setHot] = useState<{ index: number; description: string } | null>(null);
  // Reopening Browse (after a diagram closed and Home remounted) lands back where it was left.
  const [browse, setBrowse] = useState<BrowseScope | null>(() => recallBrowse()?.scope ?? null);
  // Browsing unmounts the stage; coming back is a new one to measure and observe.
  const capacity = useCapacity(stageRef, scale, gap, browse !== null);

  const sources = sourcesFor(state, controller, catalog?.PRIMARY_STARTERS ?? [], returning, {
    showAll: (scope) => setBrowse(scope),
  });
  // A row picked by hand stays picked, even once it is empty; otherwise the first with anything in it.
  const active = sources.find((source) => source.id === activeId) ?? sources.find((source) => source.tiles.length > 0) ?? sources[0];
  const history = returning;

  // The row: as many tiles as fit, the last slot giving way to "more" when there is more.
  const room = Math.max(1, capacity);
  const overflow = active ? active.tiles.length > room : false;
  const shown = active ? active.tiles.slice(0, overflow ? room - 1 : room) : [];
  const moreShown = overflow && active?.more ? active.more : undefined;

  // The projects in the row are listed (names and dates) so their stacks can be drawn; the rest wait.
  const rowProjects = active?.id === 'projects' ? shown.map((tile) => tile.entryKey.slice('projects:'.length)).join('|') : '';
  useEffect(() => {
    if (rowProjects) void controller.scanProjects(rowProjects.split('|'));
  }, [controller, rowProjects]);

  // Enter on an otherwise unfocused page starts drawing; ⌘F finds a diagram in everything.
  useEffect(() => {
    if (browse) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'f' && (mac ? event.metaKey : event.ctrlKey) && !document.querySelector('[role="dialog"]')) {
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
  }, [controller, browse, mac]);

  const choose = (id: string) => {
    setActiveId(id);
    setHot(null);
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
      rowRef.current?.querySelector<HTMLButtonElement>('.dc-starter')?.focus();
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
          mac={mac}
        />
      </div>
    );
  }

  const empty = active && active.tiles.length === 0 && !moreShown ? active.empty : undefined;

  return (
    <div
      className="dc-desk"
      ref={rootRef}
      data-mode={!state.listed ? 'pending' : returning ? 'returning' : 'first'}
      style={{ '--tile-scale': scale, '--tile-gap': `${gap}px` } as CSSProperties}
    >
      <div className="dc-desk-canvas" aria-hidden="true" />
      <UpdateChip placement="home" />

      <header className="dc-desk-top">
        <LibraryBrand />
      </header>

      <main className="dc-desk-stage" ref={stageRef}>
        {/* Nothing is drawn until Home knows whether this is a first run: then the right hero arrives once. */}
        {state.listed && (
          <>
            <div className="dc-desk-motto">
              <span className="dc-desk-motto-frame" aria-hidden="true">
                <span data-at="nw" />
                <span data-at="ne" />
                <span data-at="se" />
                <span data-at="sw" />
              </span>
              <h1>{PRODUCT.motto}</h1>
              {!returning && <p>{PRODUCT.tagline}</p>}
            </div>

            <button
              ref={actionRef}
              type="button"
              className="dc-desk-action"
              aria-label="New Quick Draft"
              aria-describedby="dc-desk-action-hint"
              aria-keyshortcuts={mac ? 'Meta+N' : 'Control+N'}
              onClick={() => void controller.newQuickDraft()}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowDown') return;
                event.preventDefault();
                (rootRef.current?.querySelector<HTMLButtonElement>('.dc-desk-label [aria-selected="true"]') ??
                  rowRef.current?.querySelector<HTMLButtonElement>('.dc-starter'))?.focus();
              }}
            >
              <Icon name="plus" size={16} />
              <span className="dc-desk-action-text">
                <span>Quick Draft</span>
                <span className="dc-desk-action-hint" id="dc-desk-action-hint">
                  Start drawing. Name it later.
                </span>
              </span>
              <kbd aria-hidden="true">{chord(mac, 'N')}</kbd>
            </button>

            <div className="dc-desk-label">
              {history ? (
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
              ) : (
                <span className="dc-desk-caption">Or start from an architecture</span>
              )}
            </div>

            <div
              className="dc-desk-row"
              id="dc-desk-row"
              ref={rowRef}
              role={history ? 'tabpanel' : 'group'}
              {...(history ? { 'aria-labelledby': `dc-desk-tab-${active?.id}` } : { 'aria-label': 'Starters' })}
            >
              {shown.map((tile, i) => (
                <DocTile
                  key={`${active!.id}:${tile.entryKey}`}
                  {...tile}
                  index={i}
                  onHot={(on) => setHot(on ? { index: i, description: tile.description } : null)}
                  onKeyDown={onTileKey}
                />
              ))}
              {moreShown && (
                <DocTile
                  key={`${active!.id}:more`}
                  entryKey={`${active!.id}:more`}
                  kind="more"
                  name={moreShown.label}
                  label={moreShown.label}
                  index={shown.length}
                  onOpen={moreShown.run}
                  onHot={(on) => setHot(on ? { index: shown.length, description: moreShown.description } : null)}
                  onKeyDown={onTileKey}
                />
              )}
              {empty && (
                <p className="dc-desk-empty" key={`${active!.id}:empty`}>
                  {empty}
                </p>
              )}
              {!catalog && shown.length === 0 && !empty && <div className="dc-desk-row-pending" />}
            </div>

            <p className="dc-desk-readout" aria-hidden="true" data-idle={hot ? undefined : 'true'}>
              {hot ? hot.description : empty ? '' : active?.note}
            </p>
            {active?.aside && active.tiles.length > 0 && <div className="dc-desk-aside">{active.aside}</div>}

            <nav className="dc-desk-ways" aria-label="More ways in">
              <DeskWay
                icon="file"
                label="New file…"
                hint="Choose where it’s saved, then draw"
                keys={chord(mac, 'N', true)}
                onClick={() => void controller.newCanvas()}
              />
              <span className="dc-desk-ways-rule" aria-hidden="true" />
              <DeskWay icon="upload" label="Open file…" keys={chord(mac, 'O')} onClick={() => void controller.openFile()} />
              <DeskWay icon="folder" label="Add project…" keys={chord(mac, 'O', true)} onClick={() => void controller.pickProject()} />
              {history && <DeskWay icon="search" label="Find a diagram" keys={chord(mac, 'F')} onClick={() => setBrowse('all')} />}
              <span className="dc-desk-ways-rule" aria-hidden="true" />
              {/* The one door to agents from Home. Optional, and off until turned on: Settings → AI agents
                  says how to connect a client, and drawing by hand never waits on it. */}
              <DeskWay
                icon="help"
                label="Connect an agent…"
                hint={state.agent?.enabled ? (state.agent.connections > 0 ? `${state.agent.connections} connected` : 'Access is on') : 'Let a coding agent draw here, over MCP'}
                onClick={() => desktopStore.update({ settingsOpen: true, settingsCategory: 'agents' })}
              />
            </nav>
          </>
        )}
      </main>

      {state.listed && (
        <footer className="dc-desk-foot">
          {/* Only where the shell actually put an icon up: some Linux desktops have nowhere for one. */}
          {state.tray && <TrayMark />}
          <span>
            {state.tray && `Available from your ${mac ? 'menu bar' : 'system tray'}. `}Your diagrams stay local.
          </span>
        </footer>
      )}

    </div>
  );
}

/** There is something to come back to: a draft, a file opened before, a project. */
function hasWork(state: DesktopState): boolean {
  return state.recovery.length > 0 || state.projects.length > 0 || state.recents.some((item) => item.kind === 'file');
}

function useCapacity(stageRef: RefObject<HTMLElement | null>, scale: number, gap: number, away: boolean): number {
  const [capacity, setCapacity] = useState(MAX_TILES);
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (away || !stage || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const fit = Math.floor((stage.clientWidth + gap) / (TILE * scale + gap));
      setCapacity(Math.max(2, Math.min(MAX_TILES, fit)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [stageRef, scale, gap, away]);
  return capacity;
}

function DeskWay({
  icon,
  label,
  hint,
  keys,
  onClick,
}: {
  icon: 'upload' | 'folder' | 'file' | 'search' | 'help';
  label: string;
  /** What it does that its name alone doesn't say. */
  hint?: string;
  /** The chord that also does it, when there is one. */
  keys?: string;
  onClick: () => void;
}) {
  return (
    <Button variant="quiet" icon={icon} className="dc-desk-way" onClick={onClick} title={[hint, keys].filter(Boolean).join('  ') || undefined}>
      {label}
      {keys && <kbd aria-hidden="true">{keys}</kbd>}
    </Button>
  );
}

/** The menu-bar icon, drawn here so "available from your menu bar" points at something you'll recognise. */
function TrayMark() {
  return (
    <svg className="dc-desk-tray-mark" viewBox="3 3.5 26 26" width="14" height="14" aria-hidden="true" focusable="false">
      <rect x="6" y="8" width="11" height="7" rx="2" />
      <rect x="15" y="18" width="11" height="7" rx="2" />
      <path d="M11.5 15.5v3.5h4" />
    </svg>
  );
}

/** A shortcut the way the platform writes one: ⇧⌘N on a Mac, Ctrl+Shift+N elsewhere. */
function chord(mac: boolean, key: string, shift = false): string {
  if (mac) return `${shift ? '⇧' : ''}⌘${key}`;
  return `Ctrl+${shift ? 'Shift+' : ''}${key}`;
}

/**
 * Everything Home can point at, most pressing first: the drafts, what was open, the projects, the
 * starters. Four at most, however many projects there are: the Projects row shows the most recent,
 * and "All" opens every one of them in the browse view. Once there is any work at all, Drafts and
 * Recent keep their place even when empty, so the tabs don't shift as a draft is saved or discarded.
 */
function sourcesFor(
  state: DesktopState,
  controller: DesktopController,
  featured: readonly ArchitectureStarter[],
  returning: boolean,
  { showAll }: { showAll: (scope: BrowseScope) => void },
): Source[] {
  const sources: Source[] = [];
  // Home's row never shows "Everything" — only Browse does — so this skips building it (it costs a
  // pass over every diagram in every project, which a returning-home render pays for on its own).
  const unsaved = state.recovery.map((entry) => draftTile(entry, controller));
  const recent = state.recents.filter((item) => item.kind === 'file').map((item) => recentTile(item, controller));

  if (returning) {
    sources.push({
      id: 'unsaved',
      label: 'Drafts',
      tiles: unsaved,
      note: 'Drafts are saved locally. Save to a file whenever you’re ready.',
      empty: 'No drafts. A Quick Draft you draw on waits here until you save it.',
      more: { label: `All ${unsaved.length}`, description: 'Every draft not saved to a file yet', run: () => showAll('unsaved') },
    });
  }

  if (returning) {
    sources.push({
      id: 'recent',
      label: 'Recent',
      tiles: recent,
      note: 'Files you opened lately',
      empty: 'Nothing opened lately. Files you open or save show up here.',
      more: { label: `All ${recent.length}`, description: 'Everything opened lately', run: () => showAll('recent') },
      aside: (
        <Button variant="quiet" className="dc-desk-aside-action" onClick={() => void controller.clearRecents()}>
          Clear recent
        </Button>
      ),
    });
  }

  if (state.projects.length > 0) {
    sources.push({
      id: 'projects',
      label: 'Projects',
      tiles: state.projects.map((project) => projectCard(project, () => showAll({ project: project.info.handle, relPath: '' }), controller)),
      note: 'Folders of diagrams you added',
      more: {
        label: `All ${state.projects.length}`,
        description: `Every project, and every diagram in them`,
        run: () => showAll('all'),
      },
    });
  }

  sources.push({
    id: 'starters',
    label: 'Starters',
    tiles: featured.map((starter) => ({
      entryKey: `starter:${starter.id}`,
      kind: 'document' as const,
      name: starter.name,
      label: `Start from ${starter.name}`,
      glyph: starterShape(starter),
      description: `${starter.description} — starts a Quick Draft with it`,
      haystack: starter.name.toLowerCase(),
      onOpen: () => void controller.newQuickDraft(starter.id),
    })),
    note: 'Each starts a Quick Draft with it; more are in the command palette once you are drawing',
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
