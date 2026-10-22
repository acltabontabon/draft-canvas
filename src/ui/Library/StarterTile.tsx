import { useId, type CSSProperties, type FocusEvent } from 'react';
import type { ArchitectureStarter, StarterId } from '../../starters/types';
import { SelectionChrome } from './SelectionChrome';
import { StarterGlyph } from './StarterGlyph';
import { starterShape } from './starterShape';

/**
 * One starter, shown as the thing it will draw: its own topology (derived from the catalog — see
 * `starterShape.ts`) with its name under it. Each surface supplies its own framing.
 *
 * Shared by Home, the empty canvas and the full collection, so their drawings cannot drift.
 *
 * `describe` adds a visible caption in the full collection; the smaller shelves keep it as a
 * screen-reader description.
 */
export function StarterTile({
  starter,
  index,
  onStart,
  onPointerEnter,
  onFocus,
  describe = false,
}: {
  starter: ArchitectureStarter;
  /** Position in the whole list, for the arrival stagger (`--i`). */
  index: number;
  describe?: boolean;
  onStart: (id: StarterId) => void;
  onPointerEnter?: () => void;
  onFocus?: (event: FocusEvent<HTMLButtonElement>) => void;
}) {
  const descriptionId = useId();
  const glyph = starterShape(starter);
  return (
    <button
      type="button"
      className="dc-starter"
      data-starter={starter.id}
      aria-label={`Start from ${starter.name}`}
      aria-describedby={descriptionId}
      style={{ '--i': index } as CSSProperties}
      onClick={() => onStart(starter.id)}
      onPointerEnter={onPointerEnter}
      onFocus={onFocus}
    >
      <span
        className="dc-starter-swatch"
        style={
          {
            '--cx': `${Math.round(glyph.centerX * 100)}%`,
            '--bx': `${glyph.bounds.x}px`,
            '--by': `${glyph.bounds.y}px`,
            '--bw': `${glyph.bounds.width}px`,
            '--bh': `${glyph.bounds.height}px`,
          } as CSSProperties
        }
      >
        <StarterGlyph starter={glyph} />
        <SelectionChrome />
      </span>
      <span className="dc-starter-name">{starter.name}</span>
      <span id={descriptionId} className={describe ? 'dc-starter-description' : 'dc-sr-only'}>
        {starter.description}
      </span>
    </button>
  );
}
