import { useState, type KeyboardEvent, type Ref } from 'react';
import { STARTER_CATEGORIES, type ArchitectureStarter, type StarterId } from '../../starters/types';
import { StarterTile } from './StarterTile';

const IDLE_READOUT = '←→ browse · ↵ start';

/**
 * The starters as things you can see before you pick one: each tile is the starter's own topology
 * (derived from the catalog — see `starterShapes.ts`) on a patch of canvas, with its name under
 * it. No card, no border, no description competing for attention — the shape says what it is, and
 * the one readout line under the shelf says the rest for whichever tile is under the pointer or
 * the keyboard.
 *
 * Scales by rows, not by redesign: every category is the same auto-filling grid at the same
 * width, so columns line up across categories and the twenty-fifth starter lands where the
 * tenth's neighbours already are.
 *
 * Keyboard: every tile is an ordinary Tab stop; arrows are a shortcut on top. ←/→ walk the list,
 * ↑/↓ keep the column (across categories too), Home/End jump to the ends. ← or ↑ past the first
 * tile hands focus back via `onExitStart`, if the page has somewhere to hand it.
 */
export function StarterShelf({
  starters,
  onStart,
  onExitStart,
  shelfRef,
}: {
  starters: readonly ArchitectureStarter[];
  onStart: (id: StarterId) => void;
  onExitStart?: () => void;
  shelfRef?: Ref<HTMLDivElement>;
}) {
  // What the readout describes, and whether the keyboard put it there — only then is ↵ true.
  const [active, setActive] = useState<{ starter: ArchitectureStarter; focused: boolean } | null>(null);
  const categories = STARTER_CATEGORIES.map((category) => ({
    ...category,
    starters: starters.filter((starter) => starter.category === category.id),
  })).filter((category) => category.starters.length > 0);
  const indexOf = new Map(starters.map((starter, i) => [starter.id, i] as const));

  return (
    <div className="dc-shelf" ref={shelfRef}>
      <div
        className="dc-shelf-categories"
        role="group"
        aria-label="Starters"
        onKeyDown={(event) => onShelfKeyDown(event, onExitStart)}
        onPointerLeave={(event) => {
          // Back to whatever the keyboard is on, if anything — not blank while a tile is focused.
          const focused = event.currentTarget.querySelector<HTMLElement>('.dc-starter:focus');
          const starter = starters.find((candidate) => candidate.id === focused?.dataset.starter);
          setActive(starter && focused ? { starter, focused: isFocusVisible(focused) } : null);
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setActive(null);
        }}
      >
        {categories.map((category) => (
          <div key={category.id} className="dc-shelf-category" role="group" aria-label={category.label}>
            <span className="dc-shelf-label" aria-hidden="true">
              {category.label}
              <span className="dc-shelf-count">{category.starters.length}</span>
            </span>
            <div className="dc-shelf-grid">
              {category.starters.map((starter) => (
                <StarterTile
                  key={starter.id}
                  starter={starter}
                  index={indexOf.get(starter.id) ?? 0}
                  onStart={onStart}
                  onPointerEnter={() => setActive({ starter, focused: false })}
                  onFocus={(event) => setActive({ starter, focused: isFocusVisible(event.currentTarget) })}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="dc-shelf-readout" aria-hidden="true" data-idle={active ? undefined : 'true'}>
        {active ? (
          <>
            <span className="dc-shelf-readout-name">{active.starter.name}</span>
            <span className="dc-shelf-readout-sep">—</span>
            {active.starter.description}
            {active.focused && <kbd className="dc-shelf-readout-key">↵</kbd>}
          </>
        ) : (
          IDLE_READOUT
        )}
      </p>
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

function onShelfKeyDown(event: KeyboardEvent<HTMLDivElement>, onExitStart: (() => void) | undefined): void {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const tile = (event.target as HTMLElement).closest<HTMLButtonElement>('.dc-starter');
  if (!tile) return;
  const grids = [...event.currentTarget.querySelectorAll('.dc-shelf-grid')];
  const groups = grids.map((grid) => [...grid.querySelectorAll<HTMLButtonElement>('.dc-starter')]);
  const flat = groups.flat();
  const at = flat.indexOf(tile);
  const g = groups.findIndex((group) => group.includes(tile));
  if (at < 0 || g < 0) return;
  const group = groups[g]!;
  const i = group.indexOf(tile);
  const cols = columnsOf(grids[g]!);
  const col = i % cols;

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
      } else if (groups[g + 1]) {
        const next = groups[g + 1]!;
        target = next[Math.min(col, next.length - 1)];
      }
      break;
    case 'ArrowUp':
      if (i >= cols) {
        target = group[i - cols];
      } else if (groups[g - 1]) {
        const prev = groups[g - 1]!;
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
}
