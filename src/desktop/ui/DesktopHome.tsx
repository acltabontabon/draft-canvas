import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { isImeKeyEvent } from '../../lib/isEditableTarget';
import { relativeTime } from '../../lib/relativeTime';
import { PRODUCT } from '../../product';
import type { ArchitectureStarter, StarterId } from '../../starters';
import { StarterBrowser } from '../../ui/Editor/StarterBrowser';
import { Button } from '../../ui/common/Button';
import { Icon } from '../../ui/common/Icon';
import { LibraryBrand } from '../../ui/Library/LibraryBrand';
import { starterShape } from '../../ui/Library/starterShapes';
import { useSpotlight } from '../../ui/Library/useSpotlight';
import { useStarters } from '../../ui/Library/useStarters';
import type { ProjectFile, RecentItem, RecoveryEntry } from '../api';
import type { DesktopController } from '../controller';
import type { DesktopState } from '../store';
import { useDesktopController, useDesktopState } from '../useDesktop';
import { DocTile, type DocTileProps } from './DocTile';
import { UpdateChip } from './Updates';
import { useDeskGeometry, type DeskGeometry } from './useDeskGeometry';
import './desktop.css';

/** A tile's drawing is 144px wide; the row keeps this much air between them. */
const TILE = 144;
const GAP = 36;
/** However wide the window, one row stays one glance. */
const MAX_TILES = 6;

type TileSpec = Omit<DocTileProps, 'index' | 'onHot' | 'onKeyDown'> & { description: string };

/** One thing the fan can point at: the drafts, the recent files, the open project, the starters. */
interface Source {
  id: string;
  label: string;
  tiles: TileSpec[];
  /** What the row's last tile does when there are more than fit: show them all, or browse starters. */
  more?: { label: string; description: string; run: () => void };
  /** A line of the source's own actions, under the readout. */
  aside?: ReactNode;
}

/**
 * Where the desktop app opens — and it is itself a diagram, drawn in the app's own hand. The motto
 * is a text node, just placed and still selected; a connector runs from it into the one thing to do,
 * New Quick Draft; and from there a single bus fans out to a row of the person's own work, each
 * file drawn as the diagram it is. The bus's label is where the row is chosen, the way a connector
 * on the canvas carries a label: Unsaved, Recent, the open project, Starters.
 *
 * It knows names and dates first. A file's drawing is read only once its tile is on screen, a
 * handful at a time, and never through anything that would count as opening it.
 */
export function DesktopHome() {
  const state = useDesktopState();
  const controller = useDesktopController();
  const catalog = useStarters();
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLElement>(null);
  const mottoRef = useRef<HTMLDivElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const spotlight = useSpotlight(canvasRef);
  const mac = state.platform !== 'windows' && state.platform !== 'linux';

  const [activeId, setActiveId] = useState<string | null>(null);
  const [hot, setHot] = useState<{ index: number; description: string } | null>(null);
  const [listing, setListing] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const capacity = useCapacity(stageRef);

  const sources = sourcesFor(state, controller, catalog?.FEATURED_STARTERS ?? [], {
    showAll: (id) => setListing((open) => (open === id ? null : id)),
    browseStarters: () => setBrowsing(true),
  });
  const active = sources.find((source) => source.id === activeId) ?? sources[0];
  const history = sources.some((source) => source.id !== 'starters');

  // The row: as many tiles as fit, the last slot giving way to "more" when there is more.
  const room = Math.max(1, capacity);
  const overflow = active ? active.tiles.length > room || (active.more !== undefined && active.id === 'starters') : false;
  const shown = active ? active.tiles.slice(0, overflow ? room - 1 : room) : [];
  const moreShown = overflow && active?.more ? active.more : undefined;
  const geometry = useDeskGeometry(stageRef, mottoRef, actionRef, rowRef, `${active?.id}:${shown.map((tile) => tile.entryKey).join('|')}:${moreShown ? 1 : 0}`);

  // Enter on an otherwise unfocused page starts drawing.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Enter' || event.repeat || event.defaultPrevented || isImeKeyEvent(event)) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (event.target !== document.body && event.target !== document.documentElement) return;
      if (document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      void controller.newQuickDraft();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [controller]);

  const choose = (id: string) => {
    setActiveId(id);
    setHot(null);
    setListing(null);
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

  const list = listing && active?.id === listing ? active : null;

  return (
    <div className="dc-desk" ref={rootRef} onPointerMove={spotlight.move} onPointerLeave={spotlight.leave}>
      <div className="dc-desk-canvas" ref={canvasRef} aria-hidden="true" />
      <UpdateChip placement="home" />

      <header className="dc-desk-top">
        <LibraryBrand />
      </header>

      <main className="dc-desk-stage" ref={stageRef}>
        {geometry && <Connectors geometry={geometry} hot={hot?.index ?? null} dashedLast={moreShown !== undefined} />}

        <div className="dc-desk-motto" ref={mottoRef}>
          <span className="dc-desk-motto-frame" aria-hidden="true">
            <span data-at="nw" />
            <span data-at="ne" />
            <span data-at="se" />
            <span data-at="sw" />
          </span>
          <h1>{PRODUCT.motto}</h1>
          <p>{PRODUCT.tagline}</p>
        </div>

        <button
          ref={actionRef}
          type="button"
          className="dc-desk-action"
          onClick={() => void controller.newQuickDraft()}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowDown') return;
            event.preventDefault();
            (rootRef.current?.querySelector<HTMLButtonElement>('.dc-desk-label [aria-selected="true"]') ??
              rowRef.current?.querySelector<HTMLButtonElement>('.dc-starter'))?.focus();
          }}
        >
          <Icon name="plus" size={16} />
          New Quick Draft
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
                  data-source={source.id}
                  aria-selected={source.id === active?.id}
                  tabIndex={source.id === active?.id ? 0 : -1}
                  onClick={() => choose(source.id)}
                  onKeyDown={(event) => onTabKey(event, i)}
                >
                  {source.label}
                </button>
              ))}
            </div>
          ) : (
            <span className="dc-desk-caption">or cheat a little</span>
          )}
        </div>

        <div className="dc-desk-row" ref={rowRef} role={history ? 'tabpanel' : 'group'} aria-label={active?.label ?? 'Starters'}>
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
          {!catalog && shown.length === 0 && <div className="dc-desk-row-pending" />}
        </div>

        <p className="dc-desk-readout" aria-hidden="true" data-idle={hot ? undefined : 'true'}>
          {hot ? hot.description : '← → browse  ·  ↵ open'}
        </p>
        {active?.aside && <div className="dc-desk-aside">{active.aside}</div>}

        <nav className="dc-desk-ways" aria-label="More ways in">
          <DeskWay icon="upload" label="Open file…" keys={chord(mac, 'O')} onClick={() => void controller.openFile()} />
          <DeskWay icon="folder" label="Open project…" keys={chord(mac, 'O', true)} onClick={() => void controller.pickProject()} />
          <DeskWay icon="file" label="New canvas…" keys={chord(mac, 'N', true)} onClick={() => void controller.newCanvas()} />
        </nav>

        {list && (
          <section className="dc-desk-all" aria-label={`All of ${list.label}`}>
            <ul>
              {list.tiles.map((tile) => (
                <li key={tile.entryKey}>
                  <button type="button" onClick={tile.onOpen} title={tile.description}>
                    <span className="dc-desk-all-name">
                      {tile.edited && <span className="dc-desk-edited" aria-hidden="true" />}
                      {tile.name}
                    </span>
                    <span className="dc-desk-all-meta">{tile.description}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>

      <footer className="dc-desk-foot">
        <TrayMark />
        <span>
          Lives in your {mac ? 'menu bar' : 'system tray'} — {chord(mac, 'N')} from anywhere. Only the files you choose; nothing you draw
          leaves this computer.
        </span>
      </footer>

      {browsing && (
        <StarterBrowser
          onStart={(id: StarterId) => {
            setBrowsing(false);
            void controller.newQuickDraft(id);
          }}
          onClose={() => setBrowsing(false)}
        />
      )}
    </div>
  );
}

/**
 * The desk's connectors, in the canvas's own hand: the motto into the Quick Draft node, and one
 * trunk from it down to a bus with a drop into every tile — rounded orthogonal corners and small
 * arrowheads, the way the editor routes a fan-out. The tile under the pointer gets its whole route
 * lit, with one pulse travelling down it.
 */
function Connectors({ geometry, hot, dashedLast }: { geometry: DeskGeometry; hot: number | null; dashedLast: boolean }) {
  const { width, height, motto, actionTop, actionBottom, busY, tiles } = geometry;
  const routes = tiles.map((tile) => routeTo(actionBottom, busY, tile));
  return (
    <svg className="dc-desk-wires" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" focusable="false">
      <circle className="dc-desk-anchor" cx={motto.x} cy={motto.y} r={3} />
      <path className="dc-desk-link" d={`M${motto.x} ${motto.y + 3}V${actionTop.y - 3}`} pathLength={1} />
      <path className="dc-desk-arrow dc-desk-link-arrow" d={arrow(actionTop.x, actionTop.y - 3)} />
      {/* The lit route last, so the trunk and bus it shares with the others are drawn in its colour. */}
      {routes
        .map((route, i) => ({ route, i }))
        .sort((a, b) => Number(a.i === hot) - Number(b.i === hot))
        .map(({ route, i }) => (
          <g key={i} className="dc-desk-route" data-hot={hot === i ? '' : undefined} data-dashed={dashedLast && i === routes.length - 1 ? '' : undefined}>
            <path className="dc-desk-route-line" d={route.d} pathLength={1} />
            <path className="dc-desk-arrow" d={arrow(route.end.x, route.end.y)} />
            <path className="dc-desk-route-pulse" d={route.d} pathLength={1} />
          </g>
        ))}
      {tiles.length > 1 && <circle className="dc-desk-junction" cx={actionBottom.x} cy={busY} r={2.5} />}
    </svg>
  );
}

const CORNER = 10;

function routeTo(from: { x: number; y: number }, busY: number, to: { x: number; y: number }) {
  // Air between the arrowhead and the drawing, as the canvas never lets a connector touch its node.
  const end = { x: to.x, y: to.y - 6 };
  const dx = to.x - from.x;
  if (Math.abs(dx) < 1) return { d: `M${from.x} ${from.y}V${end.y}`, end };
  const r = Math.min(CORNER, Math.abs(dx) / 2, (busY - from.y) / 2, (end.y - busY) / 2);
  const s = Math.sign(dx);
  const d = [
    `M${from.x} ${from.y}`,
    `V${busY - r}`,
    `Q${from.x} ${busY} ${from.x + s * r} ${busY}`,
    `H${to.x - s * r}`,
    `Q${to.x} ${busY} ${to.x} ${busY + r}`,
    `V${end.y}`,
  ].join('');
  return { d, end };
}

function arrow(x: number, y: number): string {
  return `M${x - 4} ${y - 5}L${x} ${y}L${x + 4} ${y - 5}`;
}

/** How many tiles fit the stage's width, kept current as the window is resized. */
function useCapacity(stageRef: RefObject<HTMLElement | null>): number {
  const [capacity, setCapacity] = useState(MAX_TILES);
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const fit = Math.floor((stage.clientWidth + GAP) / (TILE + GAP));
      setCapacity(Math.max(2, Math.min(MAX_TILES, fit)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [stageRef]);
  return capacity;
}

function DeskWay({ icon, label, keys, onClick }: { icon: 'upload' | 'folder' | 'file'; label: string; keys: string; onClick: () => void }) {
  return (
    <Button variant="quiet" icon={icon} className="dc-desk-way" onClick={onClick}>
      {label}
      <kbd aria-hidden="true">{keys}</kbd>
    </Button>
  );
}

/** The menu-bar icon, drawn here so "lives in your menu bar" points at something you'll recognise. */
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

function folderOf(file: ProjectFile): string {
  return file.relPath.includes('/') ? file.relPath.slice(0, file.relPath.lastIndexOf('/')) : '';
}

/** Everything the fan can point at, most pressing first: what isn't saved, what was open, the open folder, the starters. */
function sourcesFor(
  state: DesktopState,
  controller: DesktopController,
  featured: readonly ArchitectureStarter[],
  { showAll, browseStarters }: { showAll: (id: string) => void; browseStarters: () => void },
): Source[] {
  const sources: Source[] = [];

  if (state.recovery.length > 0) {
    sources.push({
      id: 'unsaved',
      label: 'Unsaved',
      tiles: state.recovery.map((entry) => draftTile(entry, controller)),
      more: { label: `All ${state.recovery.length}`, description: 'Every draft that isn’t saved yet', run: () => showAll('unsaved') },
    });
  }

  const recent = state.recents.filter((item) => item.displayPath !== state.project?.info.displayPath);
  if (recent.length > 0) {
    sources.push({
      id: 'recent',
      label: 'Recent',
      tiles: recent.map((item) => recentTile(item, controller)),
      more: { label: `All ${recent.length}`, description: 'Everything opened lately', run: () => showAll('recent') },
      aside: (
        <Button variant="quiet" className="dc-desk-aside-action" onClick={() => void controller.clearRecents()}>
          Clear recent
        </Button>
      ),
    });
  }

  const project = state.project;
  if (project) {
    const newest = [...project.files].sort((a, b) => b.mtimeMs - a.mtimeMs);
    sources.push({
      id: 'project',
      label: project.info.name,
      tiles: project.loading ? [] : newest.length > 0 ? newest.map((file) => projectTile(file, project.info.name, controller)) : [firstInProject(project.info.name, controller)],
      more: { label: `All ${project.files.length}`, description: `Every diagram in ${project.info.name}`, run: () => showAll('project') },
      aside: (
        <>
          <span className="dc-desk-aside-path" title={project.info.displayPath}>
            {project.info.displayPath}
          </span>
          <Button variant="quiet" className="dc-desk-aside-action" onClick={() => void controller.refreshProject()}>
            Refresh
          </Button>
          <Button variant="quiet" className="dc-desk-aside-action" onClick={() => controller.closeProject()}>
            Close project
          </Button>
          {project.truncated && <span className="dc-desk-aside-path">Some subfolders weren’t listed.</span>}
        </>
      ),
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
      onOpen: () => void controller.newQuickDraft(starter.id),
    })),
    more: { label: 'All starters', description: 'Every architecture and pattern Draft Canvas knows', run: browseStarters },
  });

  return sources;
}

function draftTile(entry: RecoveryEntry, controller: DesktopController): TileSpec {
  const fromFile = entry.origin.kind === 'file';
  const name = entry.origin.kind === 'file' ? entry.origin.name : entry.title;
  const when = relativeTime(entry.updatedAt);
  return {
    entryKey: `draft:${entry.id}`,
    kind: 'document',
    name,
    meta: fromFile ? `Unsaved · ${when}` : when,
    edited: true,
    label: `Recover ${name}`,
    description: `${fromFile ? 'Unsaved changes' : 'Not saved yet'} · ${when}`,
    thumbnail: { key: `draft:${entry.id}:${entry.updatedAt}`, load: () => controller.peek({ kind: 'draft', id: entry.id }) },
    onOpen: () => void controller.recover(entry.id),
    action: { label: `Discard ${name}`, icon: 'trash', run: () => void controller.discardRecovery(entry.id) },
  };
}

function recentTile(item: RecentItem, controller: DesktopController): TileSpec {
  const folder = item.kind === 'project';
  return {
    entryKey: `recent:${item.handle}`,
    kind: folder ? 'folder' : 'document',
    name: item.name,
    meta: folder ? 'Project' : relativeTime(item.lastOpenedMs),
    label: folder ? `Open the ${item.name} project` : `Open ${item.name}`,
    description: `${item.displayPath} · opened ${relativeTime(item.lastOpenedMs)}`,
    thumbnail: folder ? undefined : { key: `${item.displayPath}:${item.lastOpenedMs}`, load: () => controller.peek({ kind: 'recent', handle: item.handle }) },
    onOpen: () => void (folder ? controller.openProject(item.handle) : controller.openHandle(item.handle)),
    action: { label: `Remove ${item.name} from Recent`, icon: 'close', run: () => void controller.forgetRecent(item.handle) },
  };
}

function projectTile(file: ProjectFile, projectName: string, controller: DesktopController): TileSpec {
  const key = `project:${file.relPath}`;
  return {
    entryKey: key,
    kind: 'document',
    name: file.name,
    meta: relativeTime(file.mtimeMs),
    label: `Open ${file.name}`,
    description: `${folderOf(file) || projectName} · edited ${relativeTime(file.mtimeMs)}`,
    thumbnail: { key: `${key}:${file.mtimeMs}:${file.size}`, load: () => controller.peek({ kind: 'project', relPath: file.relPath }) },
    onOpen: () => void controller.openProjectFile(file.relPath),
  };
}

function firstInProject(projectName: string, controller: DesktopController): TileSpec {
  return {
    entryKey: 'project:new',
    kind: 'document',
    name: 'New canvas…',
    meta: 'The first one here',
    label: `New canvas in ${projectName}`,
    description: `Nothing in ${projectName} yet — start its first diagram`,
    onOpen: () => void controller.newCanvas(),
  };
}
