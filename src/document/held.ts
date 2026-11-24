import type { DraftNode } from './types';

/**
 * Shapes held in place (`DraftNode.held`), as the layout reads them. Holding a shape fixes more than
 * the shape: a held boundary keeps everything inside it where it is, and a held shape inside a
 * boundary keeps that whole boundary as it is. Everything else is free to be laid out around them.
 */

/** Every shape Arrange and Tidy up must leave exactly where it is. Empty when nothing is held. */
export function fixedIds(nodes: readonly DraftNode[]): Set<string> {
  const fixed = new Set<string>();
  if (!nodes.some((node) => node.held)) return fixed;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  /** The outermost boundary a shape sits in, or the shape itself when it is in none. */
  const rootOf = (node: DraftNode): DraftNode => {
    const seen = new Set<string>();
    let at = node;
    while (at.parentId && !seen.has(at.id)) {
      seen.add(at.id);
      const parent = byId.get(at.parentId);
      if (!parent) break;
      at = parent;
    }
    return at;
  };
  // A held shape inside a boundary holds the whole of its outermost boundary: a boundary that had to
  // stay under one shape while the rest of what it holds was laid out elsewhere would stretch across
  // the diagram to keep them. A held boundary holds what is inside it for the same reason.
  const roots = new Set<string>();
  for (const node of nodes) if (node.held) roots.add(rootOf(node).id);
  for (const node of nodes) if (roots.has(rootOf(node).id)) fixed.add(node.id);
  return fixed;
}

/** How many shapes the person marked as held (not everything that stays put because of them). */
export function heldCount(nodes: readonly DraftNode[]): number {
  let count = 0;
  for (const node of nodes) if (node.held) count += 1;
  return count;
}
