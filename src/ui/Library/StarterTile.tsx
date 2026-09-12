import { useId, type CSSProperties, type FocusEvent } from 'react';
import type { ArchitectureStarter, StarterId } from '../../starters';
import { SelectionChrome } from './SelectionChrome';
import { StarterGlyph } from './StarterGlyph';
import { starterShape } from './starterShapes';

/**
 * One starter, shown as the thing it will draw: its own topology (derived from the catalog — see
 * `starterShapes.ts`) with its name under it. No card, no border, no description competing for
 * attention — the shape says what it is.
 *
 * Shared by the home screen's shelf and the editor's empty canvas so the two surfaces cannot
 * drift. The only difference between them is the patch of dot grid behind the drawing, which the
 * empty canvas turns off: there it sits on the real canvas instead.
 */
export function StarterTile({
  starter,
  index,
  onStart,
  onPointerEnter,
  onFocus,
}: {
  starter: ArchitectureStarter;
  /** Position in the whole list, for the arrival stagger (`--i`). */
  index: number;
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
      <span id={descriptionId} className="dc-sr-only">
        {starter.description}
      </span>
    </button>
  );
}
