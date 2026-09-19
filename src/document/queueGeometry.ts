import { dataStoreGlyphBounds } from './dataStoreGeometry';
import type { DraftNode } from './types';

/**
 * Where a Queue/Topic/Stream node's tube glyph sits, vertically, relative to the node's own top
 * edge — mirrors `nodes/describe.ts`'s `queue()` geometry exactly (`y`/`tubeH`; that function
 * computes the same numbers for drawing). The tube is a compact glyph anchored near the top of the
 * box (the name/kind captions sit in the remaining space below it), so its own visual centre sits
 * well above the box's vertical midpoint.
 *
 * Lives in `document/` rather than beside the renderer because it's *placement* knowledge, not
 * drawing: `edges/routing.ts` reads it (via `anchorBandOf`) so a left/right connector lands on the
 * glyph instead of on the gap between the tube and its caption.
 */
export function queueTubeSpan(height: number): { top: number; bottom: number } {
  const h = height - 1.5;
  const tubeH = Math.min(32, h * 0.5);
  const top = 0.75;
  return { top, bottom: top + tubeH };
}

/**
 * Where a connector's anchors land, when that isn't simply the box's own edge — for a node whose
 * drawn glyph is smaller than its box. Only anchor placement reads it: obstacle, overlap and
 * selection geometry always use the full box.
 *
 * `top`/`bottom` is the absolute vertical band a left/right connector is distributed over. The
 * optional `left`/`right` are the absolute x of the glyph's own edges, where a left/right
 * connector meets it instead of the box edge; `glyphTop` is the y a top connector meets it at.
 * Absent means the box edge.
 */
export interface AnchorBand {
  top: number;
  bottom: number;
  left?: number;
  right?: number;
  glyphTop?: number;
}

/**
 * The band a node's connectors should land on — the tube for a queue-family node (vertical only:
 * it fills the box's width), the glyph for a Data Store (which is narrow, centred and sits near the
 * top of its box, so a left/right arrow used to stop a good way short of it), `undefined` (meaning
 * the whole side) for everything else, whose drawn body fills its box. A bottom connector is
 * unaffected: it leaves below the captions rather than through them.
 */
export function anchorBandOf(
  node: Pick<DraftNode, 'type' | 'x' | 'y' | 'width' | 'height'>,
): AnchorBand | undefined {
  if (node.type === 'queue') {
    const span = queueTubeSpan(node.height);
    return { top: node.y + span.top, bottom: node.y + span.bottom };
  }
  if (node.type === 'database') {
    const glyph = dataStoreGlyphBounds(node);
    return { top: glyph.top, bottom: glyph.bottom, left: glyph.left, right: glyph.right, glyphTop: glyph.top };
  }
  return undefined;
}
