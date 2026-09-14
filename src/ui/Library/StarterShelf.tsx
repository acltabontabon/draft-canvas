import { useId, useState, type KeyboardEvent, type Ref } from 'react';
import { flushSync } from 'react-dom';
import { STARTER_CATEGORIES, type ArchitectureStarter, type StarterCategory, type StarterId } from '../../starters/types';
import { StarterTile } from './StarterTile';

const INDEX_READOUT = '↑↓ category · ←→ browse · ↵ start';

/** Where focus should land in a panel that has just been made active. */
type Landing = 'first' | { row: 'first' | 'last'; col: number };

/**
 * The starters as things you can see before you pick one: each tile is the starter's own topology
 * (derived from the catalog — see `starterShapes.ts`) on a patch of canvas, with its name under
 * it. No card, no border, no description competing for attention — the shape says what it is.
 *
 * Two layouts. `index` (the home screen) is an architecture index, not a gallery: the categories
 * are branches on the connector's spine, one branch open at a time — its tiles on a shelf that is
 * always the height of the largest category, so opening another branch moves nothing — and the
 * closed ones just a label: the label says there is more, the tiles say what. One
 * readout line under the shelf describes whichever tile is under the pointer or the keyboard.
 * `all` (the Browse-all dialog) lays every category out in full, and each tile describes itself
 * in place on hover or focus instead — with thirteen on screen, a line along the bottom is too far
 * from the tile it is about.
 * Either way, the catalog decides the categories and the counts; nothing here is a second list.
 *
 * Keyboard, `index`: the open branch is the one tab stop of the index; ↑/↓ open the next or
 * previous branch, → or ↵ step into its tiles. Every tile is an ordinary Tab stop; arrows are a
 * shortcut on top. ←/→ walk the open branch's tiles and stop at its ends; ↑/↓ keep the column, and
 * past the shelf's top or bottom row they open the previous or next branch and keep going, so the
 * whole catalog is one walk. ← on a branch's first tile, or ↑ on the very first row of the index,
 * hands focus back via `onExitStart`, if the page has somewhere to hand it.
 */
export function StarterShelf({
  starters,
  onStart,
  onExitStart,
  onActiveChange,
  shelfRef,
  mode = 'index',
}: {
  starters: readonly ArchitectureStarter[];
  onStart: (id: StarterId) => void;
  onExitStart?: () => void;
  /** `index` only: which branch (by position in the index) is open, whenever that changes. */
  onActiveChange?: (index: number) => void;
  shelfRef?: Ref<HTMLDivElement>;
  mode?: 'index' | 'all';
}) {
  const baseId = useId();
  // What the readout describes, and whether the keyboard put it there — only then is ↵ true.
  const [active, setActive] = useState<{ starter: ArchitectureStarter; focused: boolean } | null>(null);
  const categories = STARTER_CATEGORIES.map((category) => ({
    ...category,
    starters: starters.filter((starter) => starter.category === category.id),
  })).filter((category) => category.starters.length > 0);
  const [openId, setOpenId] = useState<StarterCategory | null>(null);
  const openIndex = Math.max(
    0,
    categories.findIndex((category) => category.id === openId),
  );

  /**
   * Opens a branch and, if asked, puts focus on one of its tiles. The panel is `inert` until
   * React commits, so the state change is flushed first and the tile looked up after — one path
   * whether or not the branch was already the open one.
   */
  const open = (root: HTMLElement, index: number, landing?: Landing) => {
    const next = categories[Math.max(0, Math.min(index, categories.length - 1))];
    if (!next) return;
    if (next.id !== categories[openIndex]?.id) {
      // The readout described a tile that is about to be hidden.
      flushSync(() => {
        setOpenId(next.id);
        setActive(null);
      });
      onActiveChange?.(categories.indexOf(next));
    }
    if (!landing) return;
    const grid = root.querySelector<HTMLElement>('.dc-shelf-grid[data-active]');
    const tiles = grid ? [...grid.querySelectorAll<HTMLButtonElement>('.dc-starter')] : [];
    if (!grid || tiles.length === 0) return;
    if (landing === 'first') {
      tiles[0]?.focus();
      return;
    }
    const cols = columnsOf(grid);
    const lastRow = Math.floor((tiles.length - 1) / cols) * cols;
    const at = landing.row === 'first' ? landing.col : lastRow + landing.col;
    tiles[Math.min(at, tiles.length - 1)]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const root = event.currentTarget;
    const origin = event.target as HTMLElement;
    const branch = origin.closest<HTMLButtonElement>('.dc-shelf-branch');
    if (branch) {
      onBranchKeyDown(event, branch, root);
      return;
    }
    const tile = origin.closest<HTMLButtonElement>('.dc-starter');
    if (tile) onTileKeyDown(event, tile, root);
  };

  const onBranchKeyDown = (event: KeyboardEvent<HTMLDivElement>, branch: HTMLButtonElement, root: HTMLElement) => {
    const branches = [...root.querySelectorAll<HTMLButtonElement>('.dc-shelf-branch')];
    const i = branches.indexOf(branch);
    if (i < 0) return;
    let to: number | undefined;
    switch (event.key) {
      case 'ArrowDown':
        to = Math.min(i + 1, branches.length - 1);
        break;
      case 'ArrowUp':
        to = Math.max(i - 1, 0);
        break;
      case 'Home':
        to = 0;
        break;
      case 'End':
        to = branches.length - 1;
        break;
      case 'ArrowRight':
      case 'Enter':
      case ' ':
        event.preventDefault();
        open(root, i, 'first');
        return;
      case 'ArrowLeft':
        if (!onExitStart) return;
        event.preventDefault();
        onExitStart();
        return;
      default:
        return;
    }
    event.preventDefault();
    open(root, to);
    root.querySelectorAll<HTMLButtonElement>('.dc-shelf-branch')[to]?.focus();
  };

  const onTileKeyDown = (event: KeyboardEvent<HTMLDivElement>, tile: HTMLButtonElement, root: HTMLElement) => {
    const grids = [...root.querySelectorAll<HTMLElement>('.dc-shelf-grid')];
    const grid = tile.closest<HTMLElement>('.dc-shelf-grid');
    const g = grid ? grids.indexOf(grid) : -1;
    if (!grid || g < 0) return;
    const group = [...grid.querySelectorAll<HTMLButtonElement>('.dc-starter')];
    // `all` walks every category as one list; `index` walks the open branch, and crosses into
    // the next by opening it.
    const flat = mode === 'all' ? grids.flatMap((each) => [...each.querySelectorAll<HTMLButtonElement>('.dc-starter')]) : group;
    const at = flat.indexOf(tile);
    const i = group.indexOf(tile);
    if (at < 0 || i < 0) return;
    const cols = columnsOf(grid);
    const col = i % cols;
    const tilesOf = (index: number) => [...(grids[index]?.querySelectorAll<HTMLButtonElement>('.dc-starter') ?? [])];

    let target: HTMLButtonElement | undefined;
    let exit = false;
    switch (event.key) {
      case 'ArrowRight':
        target = flat[at + 1];
        break;
      case 'ArrowLeft':
        if (at === 0) exit = true;
        else target = flat[at - 1];
        break;
      case 'ArrowDown':
        if (Math.floor(i / cols) < Math.floor((group.length - 1) / cols)) {
          target = group[Math.min(i + cols, group.length - 1)];
        } else if (grids[g + 1]) {
          if (mode === 'index') {
            event.preventDefault();
            open(root, g + 1, { row: 'first', col });
            return;
          }
          const next = tilesOf(g + 1);
          target = next[Math.min(col, next.length - 1)];
        }
        break;
      case 'ArrowUp':
        if (i >= cols) {
          target = group[i - cols];
        } else if (grids[g - 1]) {
          if (mode === 'index') {
            event.preventDefault();
            open(root, g - 1, { row: 'last', col });
            return;
          }
          const prev = tilesOf(g - 1);
          const prevCols = columnsOf(grids[g - 1]!);
          const lastRow = Math.floor((prev.length - 1) / prevCols) * prevCols;
          target = prev[Math.min(lastRow + col, prev.length - 1)];
        } else {
          exit = true;
        }
        break;
      case 'Home':
        target = flat[0];
        break;
      case 'End':
        target = flat[flat.length - 1];
        break;
      default:
        return;
    }
    if (exit && onExitStart) {
      event.preventDefault();
      onExitStart();
      return;
    }
    if (!target) return;
    event.preventDefault();
    target.focus();
  };

  const indexed = mode === 'index';
  const tiles = (category: (typeof categories)[number]) =>
    category.starters.map((starter, i) => (
      <StarterTile
        key={starter.id}
        starter={starter}
        index={i}
        onStart={onStart}
        describe={!indexed}
        onPointerEnter={indexed ? () => setActive({ starter, focused: false }) : undefined}
        onFocus={indexed ? (event) => setActive({ starter, focused: isFocusVisible(event.currentTarget) }) : undefined}
      />
    ));

  return (
    <div className="dc-shelf" data-mode={mode} ref={shelfRef}>
      <div
        className="dc-shelf-categories"
        role="group"
        aria-label="Starters"
        onKeyDown={onKeyDown}
        onPointerLeave={
          indexed
            ? (event) => {
                // Back to whatever the keyboard is on, if anything — not blank while a tile is focused.
                const focused = event.currentTarget.querySelector<HTMLElement>('.dc-starter:focus');
                const starter = starters.find((candidate) => candidate.id === focused?.dataset.starter);
                setActive(starter && focused ? { starter, focused: isFocusVisible(focused) } : null);
              }
            : undefined
        }
        onBlur={
          indexed
            ? (event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setActive(null);
              }
            : undefined
        }
      >
        {indexed ? (
          <>
            <div className="dc-shelf-index" role="tablist" aria-label="Starter categories" aria-orientation="vertical">
              {categories.map((category, i) => {
                const isOpen = i === openIndex;
                return (
                  <button
                    key={category.id}
                    type="button"
                    role="tab"
                    id={`${baseId}-tab-${category.id}`}
                    className="dc-shelf-branch"
                    aria-selected={isOpen}
                    aria-controls={`${baseId}-panel-${category.id}`}
                    tabIndex={isOpen ? 0 : -1}
                    data-active={isOpen ? '' : undefined}
                    onClick={(event) => open(event.currentTarget.closest<HTMLElement>('.dc-shelf-categories')!, i)}
                  >
                    <span className="dc-shelf-label">{category.label}</span>
                  </button>
                );
              })}
            </div>
            <div className="dc-shelf-stack">
              {categories.map((category, i) => {
                const isOpen = i === openIndex;
                return (
                  <div
                    key={category.id}
                    role="tabpanel"
                    id={`${baseId}-panel-${category.id}`}
                    aria-labelledby={`${baseId}-tab-${category.id}`}
                    className="dc-shelf-grid"
                    data-active={isOpen ? '' : undefined}
                    inert={!isOpen}
                    aria-hidden={isOpen ? undefined : true}
                  >
                    {tiles(category)}
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          categories.map((category) => (
            <div key={category.id} role="group" aria-label={category.label}>
              <span className="dc-shelf-label" aria-hidden="true">
                {category.label}
              </span>
              <div className="dc-shelf-grid">{tiles(category)}</div>
            </div>
          ))
        )}
      </div>
      {indexed && (
        <p className="dc-shelf-readout" aria-hidden="true" data-idle={active ? undefined : 'true'}>
          {active ? (
            <>
              <span className="dc-shelf-readout-name">{active.starter.name}</span>
              <span className="dc-shelf-readout-sep">—</span>
              {active.starter.description}
              {active.focused && <kbd className="dc-shelf-readout-key">↵</kbd>}
            </>
          ) : (
            INDEX_READOUT
          )}
        </p>
      )}
    </div>
  );
}

/** Keyboard focus, not a click's — the only time a ↵ hint is advice someone can take. */
function isFocusVisible(element: Element): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    return true;
  }
}

function columnsOf(grid: Element): number {
  const tracks = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length;
  return Math.max(1, tracks);
}
