import { memo, useMemo } from 'react';
import { ownerAt } from '../depth/tree';
import { displayNameFor } from '../document/factory';
import { boundsOf } from '../document/operations';
import { fileOf, useEditorStore } from '../store/editorStore';

/**
 * The sheet a room is drawn on.
 *
 * Inside a shape, every other signal that you are somewhere else is momentary — the dive settles,
 * the trail is a line of text in a corner — and the canvas itself looks exactly like the canvas
 * you came from. This is the part that stays: register marks hugging what the room holds, with
 * the name of the shape it belongs to written on the corner, so "I am inside Loan Service" is a
 * fact about the drawing rather than a label somewhere else on screen.
 *
 * Register marks rather than a box, for two reasons. A rectangle around a hundred shapes is a
 * decorative border, and a rectangle is a *drawing* — in the sketch personality a crisp one would
 * be the only crisp thing on the canvas. Corner marks are printer's marks: they say "sheet" at
 * any size, in any personality, and the empty canvas already uses exactly the same four to say
 * exactly the same thing.
 *
 * Derived on every render from what the room holds and never stored, never interactive, never
 * exported as geometry — the same discipline as the alignment guides it is drawn beside.
 */
const PAD = 56;
/** So a room holding one small shape still reads as a sheet rather than a box around a box. */
const MIN = 420;

export const RoomFrame = memo(function RoomFrame() {
  const path = useEditorStore((state) => state.path);
  const nodes = useEditorStore((state) => state.document.nodes);
  // Only where there is a room to frame: the top level is the canvas, and an empty room has its
  // own invitation on screen already.
  const inside = path.length > 0 && nodes.length > 0;
  const name = useEditorStore((state) => {
    if (!inside) return null;
    const owner = ownerAt(fileOf(state), state.path);
    return owner ? displayNameFor(owner) : null;
  });

  const rect = useMemo(() => {
    if (!inside) return null;
    const bounds = boundsOf(nodes);
    if (!bounds) return null;
    const width = Math.max(bounds.width + PAD * 2, MIN);
    const height = Math.max(bounds.height + PAD * 2, MIN);
    return {
      x: bounds.x + bounds.width / 2 - width / 2,
      y: bounds.y + bounds.height / 2 - height / 2,
      width,
      height,
    };
  }, [inside, nodes]);

  if (!rect) return null;

  return (
    <div
      className="dc-room"
      aria-hidden="true"
      style={{ transform: `translate(${rect.x}px, ${rect.y}px)`, width: rect.width, height: rect.height }}
    >
      <span className="dc-room-mark" data-at="nw" />
      <span className="dc-room-mark" data-at="ne" />
      <span className="dc-room-mark" data-at="se" />
      <span className="dc-room-mark" data-at="sw" />
      {name && <span className="dc-room-name">{name}</span>}
    </div>
  );
});
