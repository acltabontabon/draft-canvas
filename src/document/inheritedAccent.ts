import type { Accent, DraftNode } from './types';

/**
 * Colour by boundary. A shape that was never given an accent draws in the accent of the nearest
 * boundary around it that has one, so colouring a boundary colours what it holds and a diagram is
 * colour-coded by where things sit, not shape by shape.
 *
 * Derived, never stored: a shape carried out of the boundary is neutral again, and a shape's own
 * accent — including an explicit `neutral` — always wins. Appearance only: it reaches the display
 * list through the callers of `describeNode` (canvas and export) and nothing else reads it, so
 * routing, semantics and what an agent is told about a shape's colour are unchanged.
 */

/** The shapes that take their boundary's accent. Notes are coloured by kind, and text, code,
 *  sequences and junctions are not tinted by where they sit. */
const INHERITS: ReadonlySet<DraftNode['type']> = new Set(['service', 'database', 'queue', 'actor', 'component']);

/** Deeper nesting than any real diagram; a cycle in `parentId` stops here rather than looping. */
const MAX_DEPTH = 32;

/** The accent `node` takes from a boundary around it, or `undefined` when it keeps its own look. */
export function inheritedAccent(
  node: Pick<DraftNode, 'type' | 'accent' | 'parentId'>,
  byId: ReadonlyMap<string, DraftNode>,
): Accent | undefined {
  if (node.accent !== undefined || !INHERITS.has(node.type)) return undefined;
  let parentId = node.parentId;
  for (let depth = 0; parentId && depth < MAX_DEPTH; depth += 1) {
    const parent = byId.get(parentId);
    if (!parent) return undefined;
    if (parent.accent && parent.accent !== 'neutral') return parent.accent;
    parentId = parent.parentId;
  }
  return undefined;
}

/** `node` as it is drawn: itself, or a copy carrying the accent it inherits. */
export function withInheritedAccent(node: DraftNode, byId: ReadonlyMap<string, DraftNode>): DraftNode {
  const accent = inheritedAccent(node, byId);
  return accent ? { ...node, accent } : node;
}
