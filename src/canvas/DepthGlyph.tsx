import { memo, useMemo } from 'react';
import type { PersonalityPreset } from '../ui/personality/usePersonality';
import { DEPTH_GLYPH_SIZE, depthGlyphPaths } from './insideMark';

/**
 * The depth glyph — a tiny stack of three layers (see `insideMark.ts`). One component everywhere it appears, inside a shape that has an inside and
 * beside "Look inside" in the popover, so the two are recognisably the same mark. Colour comes from
 * `currentColor`; the thin gap cut between layers is `--dc-depth-ground`, whatever it sits on.
 */
export const DepthGlyph = memo(function DepthGlyph({
  preset,
  seedId,
  className,
}: {
  preset: PersonalityPreset;
  seedId: string;
  className?: string;
}) {
  const paths = useMemo(() => depthGlyphPaths(preset, seedId), [preset, seedId]);
  return (
    <svg
      className={className ? `dc-depth-glyph ${className}` : 'dc-depth-glyph'}
      width={DEPTH_GLYPH_SIZE}
      height={DEPTH_GLYPH_SIZE}
      viewBox={`0 0 ${DEPTH_GLYPH_SIZE} ${DEPTH_GLYPH_SIZE}`}
      aria-hidden="true"
      focusable="false"
    >
      {paths.layers.map((d, index) => (
        <path key={index} data-layer={index} d={d} />
      ))}
    </svg>
  );
});
