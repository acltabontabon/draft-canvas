import type { DraftNode, DraftNodeType } from '../document/types';
import { minSizeFor } from '../document/factory';
import { ShapePreview } from './ShapePreview';
import type { InspectorSelectOption } from './InspectorSelect';

/**
 * Builds a kind picker's option list — one entry per architectural subtype,
 * each previewed with the *real* shape (via `ShapePreview`) rather than a
 * hand-drawn stand-in. Shared by every "developer preset" family (Service,
 * Data Store, Queue, Actor — the node types `nodes/describe.ts`'s own module
 * comment calls out as "distinct types because they carry recognisable
 * silhouettes") so a new family only needs its kind list, its label table,
 * and a one-line `nodeFor`, not a whole picker/icon implementation of its
 * own.
 *
 * The preview renders at the family's own `minSizeFor(type)` — the smallest
 * size that type's shape functions are already tuned (and tested) against —
 * and is scaled down to icon size by CSS alone, so a family whose glyphs use
 * some fixed-pixel detail (Queue's envelope icons, for one) still lays out
 * exactly as it would on a real, minimum-sized node instead of overflowing a
 * shrunk logical viewBox.
 */
export function shapeVariantOptions<K extends string>(
  type: DraftNodeType,
  kinds: readonly K[],
  labels: Record<K, string>,
  nodeFor: (kind: K) => Partial<DraftNode>,
): InspectorSelectOption[] {
  const size = minSizeFor(type);
  return kinds.map((kind) => ({
    value: kind,
    label: labels[kind],
    icon: <ShapePreview node={{ type, ...nodeFor(kind) }} width={size.width} height={size.height} />,
  }));
}
