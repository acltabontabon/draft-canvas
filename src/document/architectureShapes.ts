/**
 * Which shapes are the architecture itself, as opposed to what is drawn about it (notes, labels,
 * junctions, sequences). An agent's intent and rename checks ask this of a name before they treat it
 * as an element's.
 */
import type { DraftNode } from './types';

/** The shapes that stand for a piece of architecture. */
export function isArchitecture(node: DraftNode): boolean {
  return (
    node.type === 'service' ||
    node.type === 'database' ||
    node.type === 'queue' ||
    node.type === 'actor' ||
    node.type === 'component' ||
    node.type === 'artifact'
  );
}

export function isBoundary(node: DraftNode): boolean {
  return node.type === 'group';
}
