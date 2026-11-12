import { useId, type CSSProperties } from 'react';
import type { LibraryShape } from '../../document/types';
import { SelectionChrome } from './SelectionChrome';
import { StarterGlyph } from './StarterGlyph';
import { glyphShapeOf, type StarterShape } from './starterShapes';

/** What a tile shows of a starter: a gallery entry, or anything shaped like one. */
export interface StarterTileData {
  id: string;
  name: string;
  summary: string;
  /** Its topology; absent until its file has arrived, when the tile shows an empty sheet. */
  shape?: LibraryShape;
  mark?: 'new' | 'updated';
  /** Why it can't be chosen, shown in place of its summary. */
  unavailable?: string;
}

const glyphs = new WeakMap<LibraryShape, StarterShape>();

function glyphOf(shape: LibraryShape): StarterShape {
  let glyph = glyphs.get(shape);
  if (!glyph) {
    glyph = glyphShapeOf(shape);
    glyphs.set(shape, glyph);
  }
  return glyph;
}

/**
 * One starter, shown as the thing it will draw: its own topology (reduced from the file by
 * `libraryShapeOf`, the way every saved canvas's preview is) with its name under it. Each surface
 * supplies its own framing; the empty canvas and the Starters dialog share this, so their drawings
 * cannot drift.
 *
 * `describe` shows the summary; elsewhere it stays a screen-reader description.
 */
export function StarterTile({
  starter,
  index,
  onStart,
  describe = false,
  verb,
}: {
  starter: StarterTileData;
  /** Position in the whole list, for the arrival stagger (`--i`). */
  index: number;
  describe?: boolean;
  /** What a click does, said before the name ("Start from"); without it the name alone. */
  verb?: string;
  onStart: (id: string) => void;
}) {
  const descriptionId = useId();
  const glyph = starter.shape ? glyphOf(starter.shape) : null;
  const markLabel = starter.mark === 'new' ? 'New' : starter.mark === 'updated' ? 'Updated' : null;
  return (
    <button
      type="button"
      className="dc-starter"
      data-starter={starter.id}
      data-unavailable={starter.unavailable ? 'true' : undefined}
      aria-label={`${verb ? `${verb} ` : ''}${starter.name}${markLabel ? `, ${markLabel.toLowerCase()}` : ''}`}
      aria-describedby={descriptionId}
      style={{ '--i': index } as CSSProperties}
      onClick={() => onStart(starter.id)}
    >
      <span
        className="dc-starter-swatch"
        style={
          glyph
            ? ({
                '--cx': `${Math.round(glyph.centerX * 100)}%`,
                '--bx': `${glyph.bounds.x}px`,
                '--by': `${glyph.bounds.y}px`,
                '--bw': `${glyph.bounds.width}px`,
                '--bh': `${glyph.bounds.height}px`,
              } as CSSProperties)
            : undefined
        }
      >
        {glyph ? <StarterGlyph starter={glyph} /> : <span className="dc-starter-glyph dc-starter-glyph-empty" aria-hidden="true" />}
        <SelectionChrome />
      </span>
      <span className="dc-starter-name">
        {starter.name}
        {markLabel && <span className="dc-starter-mark" data-mark={starter.mark}>{markLabel}</span>}
      </span>
      <span id={descriptionId} className={describe ? 'dc-starter-description' : 'dc-sr-only'}>
        {starter.unavailable ?? starter.summary}
      </span>
    </button>
  );
}
