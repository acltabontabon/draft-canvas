/**
 * Where a Queue/Topic/Stream node's tube glyph sits, vertically, as a fraction (0..1) of the
 * node's own full height — mirrors `nodes/describe.ts`'s `queue()` geometry exactly (`y`/`tubeH`;
 * that function computes the same three numbers for drawing). The tube is a compact glyph anchored
 * near the top of the box (the kind caption sits in the remaining space below it), so its own
 * visual centre sits well above the box's vertical midpoint — a connector anchored at the default
 * `offset: 0.5` lands at the boundary between the tube and its caption, not the tube's centre.
 *
 * Lives in `document/` rather than beside the renderer because it's *placement* knowledge, not
 * drawing: anything that authors a horizontal connector for a queue-family node ahead of rendering
 * — `store/editorStore.ts`'s `addDeadLetterQueue`/`addConsumer`, and `starters/catalog.ts`, which
 * may import nothing but `document/` — needs it to set an `EdgeAnchor.offset` that actually lands
 * on the glyph.
 */
export function queueTubeCenterFraction(height: number): number {
  const h = height - 1.5;
  const tubeH = Math.min(32, h * 0.5);
  const top = 0.75;
  return (top + tubeH / 2) / height;
}
