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
 * The absolute vertical band a node's left/right connectors should be distributed over — the tube
 * for a queue-family node, `undefined` (meaning "the whole side") for everything else, whose drawn
 * body fills its box. Top/bottom sides are unaffected: the tube's top *is* the box top, and a
 * connector leaving downward exits below the captions rather than through them.
 */
export function anchorBandOf(
  node: Pick<DraftNode, 'type' | 'y' | 'height'>,
): { top: number; bottom: number } | undefined {
  if (node.type !== 'queue') return undefined;
  const span = queueTubeSpan(node.height);
  return { top: node.y + span.top, bottom: node.y + span.bottom };
}
