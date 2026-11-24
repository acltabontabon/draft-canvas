import type { Shape } from '../displayList';
import type { ResolvedShape } from './resolve';

const round = (value: number): number => Math.round(value * 100) / 100;

/**
 * A shape's drawing in its style's line weight, and flat when its style has no shadow.
 *
 * One pass over what the shape's own describer produced, so no describer has to know a style
 * exists: every outline it drew gets heavier or lighter together, the way one pen would. Nothing
 * moves, so a shape's size, its text and where a connector meets it are exactly as they were.
 * Returns the same list when there is nothing to do, and never changes a shape it was given.
 */
export function restyle(shapes: Shape[], look: ResolvedShape): Shape[] {
  if (look.weight === 1 && look.shadow) return shapes;
  let changed = false;
  const next = shapes.map((shape) => {
    const drawn = restyled(shape, look);
    if (drawn !== shape) changed = true;
    return drawn;
  });
  return changed ? next : shapes;
}

function restyled(shape: Shape, look: ResolvedShape): Shape {
  if (shape.t === 'group') {
    const children = restyle(shape.children, look);
    return children === shape.children ? shape : { ...shape, children };
  }
  if (shape.t !== 'rect' && shape.t !== 'ellipse' && shape.t !== 'path') return shape;
  const heavier = shape.stroke !== undefined && look.weight !== 1;
  const flat = shape.shadow === true && !look.shadow;
  if (!heavier && !flat) return shape;
  const next = { ...shape };
  if (heavier) next.stroke = { ...shape.stroke!, width: round(shape.stroke!.width * look.weight) };
  if (flat) delete next.shadow;
  return next;
}
