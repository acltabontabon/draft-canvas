import type { DraftNode } from './types';

/**
 * Shapes held in place (`DraftNode.held`), as the layout reads them. Holding a shape fixes more than
 * the shape: a held boundary keeps everything inside it where it is, and a boundary with a held shape
 * inside cannot move out from under it. Everything else is free to be laid out around them.
 */

/** Every shape Arrange and Tidy up must leave exactly where it is. Empty when nothing is held. */
export function fixedIds(nodes: readonly DraftNode[]): Set<string> {
  const fixed = new Set<string>();
  if (!nodes.some((node) => node.held)) return fixed;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    // Held itself, or inside a held boundary at any depth.
    const seen = new Set<string>();
    for (let at: DraftNode | undefined = node; at && !seen.has(at.id); at = at.parentId ? byId.get(at.parentId) : undefined) {
      seen.add(at.id);
      if (at.held) {
        fixed.add(node.id);
        break;
      }
    }
    // The boundaries around a held shape stay under it.
    if (node.held) {
      const up = new Set<string>([node.id]);
      for (let at = node.parentId ? byId.get(node.parentId) : undefined; at && !up.has(at.id); at = at.parentId ? byId.get(at.parentId) : undefined) {
        up.add(at.id);
        fixed.add(at.id);
      }
    }
  }
  return fixed;
}

/** How many shapes the person marked as held (not everything that stays put because of them). */
export function heldCount(nodes: readonly DraftNode[]): number {
  let count = 0;
  for (const node of nodes) if (node.held) count += 1;
  return count;
}
