import type { KeyboardEvent, Ref } from 'react';
import type { ArchitectureStarter, StarterId } from '../../starters/types';
import { StarterTile } from './StarterTile';

/**
 * The primary starters as things you can see before you pick one: each tile is the starter's own
 * topology (derived from the catalog — see `starterShapes.ts`) on a patch of canvas, with its name
 * under it and its one-line description revealed on hover or focus. One flat row, no categories,
 * no browser behind it: the rest of the catalog is a name away in the command palette, and a
 * chooser that showed everything would be a template picker.
 *
 * Keyboard: every tile is an ordinary Tab stop; ←/→ walk the row, Home/End jump to its ends, and ←
 * on the first tile hands focus back via `onExitStart`, if the page has somewhere to hand it.
 */
export function StarterGrid({
  starters,
  onStart,
  onExitStart,
  gridRef,
}: {
  starters: readonly ArchitectureStarter[];
  onStart: (id: StarterId) => void;
  onExitStart?: () => void;
  gridRef?: Ref<HTMLDivElement>;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const tiles = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.dc-starter')];
    const at = tiles.indexOf((event.target as HTMLElement).closest<HTMLButtonElement>('.dc-starter')!);
    if (at < 0) return;
    let target: HTMLButtonElement | undefined;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        target = tiles[at + 1];
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        if (at === 0) {
          if (!onExitStart) return;
          event.preventDefault();
          onExitStart();
          return;
        }
        target = tiles[at - 1];
        break;
      case 'Home':
        target = tiles[0];
        break;
      case 'End':
        target = tiles[tiles.length - 1];
        break;
      default:
        return;
    }
    if (!target) return;
    event.preventDefault();
    target.focus();
  };

  return (
    <div className="dc-starter-grid" role="group" aria-label="Starters" ref={gridRef} onKeyDown={onKeyDown}>
      {starters.map((starter, i) => (
        <StarterTile key={starter.id} starter={starter} index={i} onStart={onStart} describe />
      ))}
    </div>
  );
}
