import { useMemo } from 'react';
import { isLibraryShape } from '../../document/shape';
import type { LibraryShape } from '../../document/types';
import { Fingerprint } from './Fingerprint';
import { StarterGlyph } from './StarterGlyph';
import { glyphShapeOf } from './starterShapes';

/** Gallery previews use the same topology glyphs as desktop files and starters. The small list
 * fingerprint's 56-unit drawing is kept only for empty documents, rather than enlarged into a card. */
export function DocumentPreview({ shape, paper = false }: { shape: LibraryShape | undefined; paper?: boolean }) {
  const glyph = useMemo(
    () => isLibraryShape(shape) && shape.nodes.length > 0 ? glyphShapeOf(shape) : null,
    [shape],
  );
  return (
    <span className="dc-gallery-preview">
      {glyph ? <StarterGlyph starter={glyph} className="dc-fingerprint dc-gallery-glyph" /> : paper ? <span className="dc-home-empty-paper">Still a blank page</span> : <Fingerprint shape={shape} />}
    </span>
  );
}
