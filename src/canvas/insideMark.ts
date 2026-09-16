import type { Accent, DraftNode } from '../document/types';
import type { Shape } from '../render/displayList';
import { PERSONALITY_PROFILES } from '../render/roughness/presets';
import { roughenPath } from '../render/roughness/roughPath';
import type { PersonalityPreset } from '../ui/personality/usePersonality';

/** The glyph's drawing box, in its own units (1 unit = 1px at 100%). */
export const DEPTH_GLYPH_SIZE = 14;

/** One flat layer, seen from above, with its top vertex at `y`. Closed with a line back to the start
 *  rather than `Z`, so `roughenPath` (which speaks only M/L/Q/C) can draw it by hand. */
const layer = (y: number) => `M7 ${y} L12.75 ${y + 3} L7 ${y + 6} L1.25 ${y + 3} L7 ${y}`;

export interface DepthGlyphPaths {
  /** Bottom layer first, so plain document order stacks them. */
  layers: string[];
}

/**
 * Draft Canvas's depth glyph: a tiny stack of three flat layers — "there is more below this". Exact
 * in Clean; in Draft and Sketch drawn in the same hand as the lines around it, scaled down to a
 * glyph so it stays a stack.
 */
export function depthGlyphPaths(preset: PersonalityPreset, seedId: string): DepthGlyphPaths {
  const profile = PERSONALITY_PROFILES[preset];
  return {
    layers: [6.5, 4, 1.5].map((y, i) =>
      roughenPath(layer(y), `${seedId}:depth-${i}`, profile.outline * 0.15, profile.bow * 0.08),
    ),
  };
}

/**
 * A shape's own drawing, as the plane behind it: its outline alone, a little lighter — no fill, no
 * shadow, no words. The shape in front hides the part it covers, so all that ever shows is the edge
 * of a plane further back: the same outlined plane the depth map draws for a room you can go down
 * into. Anything that is only a fill (a service's accent bar) has no edge to give and is dropped; a
 * label repeated behind a shape would read as a copy rather than a plane.
 */
export function layerBehind(shapes: readonly Shape[]): Shape[] {
  const kept: Shape[] = [];
  for (const shape of shapes) {
    if (shape.t === 'text' || shape.t === 'code') continue;
    if (shape.t === 'group') {
      const children = layerBehind(shape.children);
      if (children.length > 0) kept.push({ ...shape, children });
      continue;
    }
    if (!shape.stroke) continue;
    kept.push({ ...shape, fill: 'none', shadow: false, stroke: { ...shape.stroke, width: shape.stroke.width * 0.85 } });
  }
  return kept;
}

/**
 * The accent a shape is actually drawn in when it has not been given one — the defaults
 * `nodes/describe.ts` falls back to per type — so anything tinted after a shape is in its colour.
 */
export function depthMarkAccent(node: Pick<DraftNode, 'type' | 'accent'>): Accent {
  if (node.accent) return node.accent;
  switch (node.type) {
    case 'service':
      return 'teal';
    case 'database':
      return 'blue';
    case 'queue':
      return 'violet';
    default:
      return 'neutral';
  }
}
