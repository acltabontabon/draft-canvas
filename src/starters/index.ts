/**
 * Starters — deliberately composed opening diagrams for the architectures and patterns developers
 * draw most often, inserted from ⌘K. Two categories (`StarterCategory`), purely for discovery:
 * *Architectures* organise a whole system, *Patterns* solve one recurring problem at its own scope.
 *
 * A starter is not a template: nothing it creates is special, locked, or tracked. It is the boring
 * setup done for you — normal nodes, normal connectors, normal boundaries — so a conversation can
 * start at "here's how our services talk" instead of at "let me place a few boxes."
 *
 * The layering is one-way and matches the rest of the app: `commands/` names a `store/` action,
 * the store composes `document/` operations, and this module is pure data plus the function that
 * turns it into document elements. See `docs/ARCHITECTURE.md`.
 */

export { ARCHITECTURE_STARTERS } from './catalog';
export { buildStarter, starterSize, type BuiltStarter } from './build';
export {
  STARTER_CATEGORIES,
  STARTER_IDS,
  type ArchitectureStarter,
  type StarterCategory,
  type StarterId,
} from './types';

import { ARCHITECTURE_STARTERS } from './catalog';
import type { ArchitectureStarter, StarterId } from './types';

const BY_ID = new Map<StarterId, ArchitectureStarter>(
  ARCHITECTURE_STARTERS.map((starter) => [starter.id, starter]),
);

export function starterById(id: StarterId): ArchitectureStarter | undefined {
  return BY_ID.get(id);
}

/**
 * The four the blank canvas offers as drawings; the rest are one click further, behind "Browse
 * all starters". Curation is the whole point — a blank Draft Canvas that listed every starter
 * would be a template picker, which is the opposite of what an empty canvas is for.
 *
 * Chosen for silhouette as much as for subject: a fan, a topic tree, a split and a bordered core
 * read as four different shapes at 144×76, where four variations on one shape would read as noise.
 */
export const FEATURED_STARTER_IDS: readonly StarterId[] = [
  'microservices',
  'event-driven',
  'cqrs',
  'hexagonal',
];

/** `FEATURED_STARTER_IDS` resolved, in that order, skipping any id the catalog no longer has. */
export const FEATURED_STARTERS: readonly ArchitectureStarter[] = FEATURED_STARTER_IDS.flatMap(
  (id) => BY_ID.get(id) ?? [],
);
