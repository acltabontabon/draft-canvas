/**
 * What every copy of a shared file is held to, whoever changed it: the document-wide limits
 * `validate.ts` enforces on a file from disk, and one element per id. The owner checks every
 * collaborator's patch against these; a collaborator checks every commit from the owner.
 */
import { totals } from '../depth/tree';
import { LIMITS } from '../document/limits';
import type { DraftDocument } from '../document/types';
import { indexOf } from './fileIndex';

/** Whether every node, connector and flow id appears once in the whole file — `indexOf` keeps one per id. */
export function idsUnique(file: DraftDocument): boolean {
  const count = totals(file);
  const index = indexOf(file);
  return index.nodes.size === count.nodes && index.edges.size === count.edges && index.flows.size === count.flows && new Set(file.openPoints.map((point) => point.id)).size === file.openPoints.length;
}

/** The document-wide limits `validate.ts` holds a file to, so the owner's file always reopens whole. */
export function withinLimits(file: DraftDocument): boolean {
  const count = totals(file);
  return (
    count.nodes <= LIMITS.maxNodes &&
    count.edges <= LIMITS.maxEdges &&
    count.flows <= LIMITS.maxFlows &&
    file.openPoints.length <= LIMITS.maxOpenPoints
  );
}
