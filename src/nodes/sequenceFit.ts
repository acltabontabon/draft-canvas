/**
 * Keeping a sequence node the size of what it holds.
 *
 * Nothing about a sequence is placed by hand, so its box is not something to manage either: it
 * follows the content. A box that was exactly what the sequence needed goes on being exactly that,
 * growing and shrinking as messages come and go. A box someone made larger keeps its size while
 * everything still fits and grows only when it has to — a deliberate size is never taken back.
 *
 * It grows to the right and downwards from where it stands, and nothing else on the canvas moves.
 */
import { LIMITS } from '../document/limits';
import type { DraftDocument, DraftNode } from '../document/types';
import { naturalSequenceSizeFor, type DescribeContext } from './describe';

/** Within this of what was needed counts as "exactly what was needed": measuring is not exact to the pixel. */
const SNUG = 1;

const clamp = (value: number): number => Math.min(LIMITS.maxNodeSize, Math.max(LIMITS.minNodeSize, Math.round(value)));

/**
 * `after` at the size its sequence now needs, given what `before` was (absent for a node that has
 * just arrived: a paste, a new sequence). The same node back when its size already suits.
 */
export function fitSequenceNode(before: DraftNode | undefined, after: DraftNode, ctx: DescribeContext): DraftNode {
  if (after.type !== 'sequence') return after;
  const need = naturalSequenceSizeFor(after, ctx);
  const had = before?.type === 'sequence' ? naturalSequenceSizeFor(before, ctx) : null;
  const fit = (box: number, needed: number, was: number | null, previous: number | undefined): number => {
    const snug = was !== null && previous !== undefined && previous <= was + SNUG;
    return clamp(snug ? needed : Math.max(box, needed));
  };
  const width = fit(after.width, need.width, had?.width ?? null, before?.width);
  const height = fit(after.height, need.height, had?.height ?? null, before?.height);
  return width === after.width && height === after.height ? after : { ...after, width, height };
}

/**
 * `after` with every sequence that changed since `before` — what it holds, or its title — at the
 * size it now needs. The same document back when none did, which is nearly always.
 */
export function fitSequences(before: DraftDocument, after: DraftDocument, ctx: () => DescribeContext): DraftDocument {
  if (after === before || after.nodes === before.nodes) return after;
  let previous: Map<string, DraftNode> | null = null;
  let context: DescribeContext | null = null;
  let nodes: DraftNode[] | null = null;
  for (let index = 0; index < after.nodes.length; index += 1) {
    const node = after.nodes[index]!;
    if (node.type !== 'sequence') continue;
    previous ??= new Map(before.nodes.filter((candidate) => candidate.type === 'sequence').map((candidate) => [candidate.id, candidate]));
    const was = previous.get(node.id);
    if (was && was.sequence === node.sequence && was.text === node.text) continue;
    context ??= ctx();
    const fitted = fitSequenceNode(was, node, context);
    if (fitted === node) continue;
    nodes ??= after.nodes.slice();
    nodes[index] = fitted;
  }
  return nodes ? { ...after, nodes } : after;
}
