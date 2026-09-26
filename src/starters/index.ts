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
 * turns it into document elements. See `docs/reference/architecture.md`.
 */

export { ARCHITECTURE_STARTERS } from './catalog';
export { buildStarter, starterSize, type BuiltStarter } from './build';
export { starterDocument } from './document';
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
 * The five every chooser offers — the home screen, the blank canvas, the desktop's Home. The rest
 * of the catalog stays reachable by name through the command palette (and to an agent through
 * `create_diagram`), and is listed in `docs/guides/examples.md`. Curation is the whole point — a
 * chooser that listed every starter would be a template picker, which is the opposite of what a
 * blank canvas is for — and the set is frozen: it is chosen for teaching value and how easily each
 * is adapted, not for how many architectures Draft Canvas knows.
 *
 * One of each shape a first diagram tends to take: a layered box, a fan, a topic tree, a bordered
 * core and a split. Two variations on one shape would read as noise at tile size.
 */
const PRIMARY_STARTER_IDS: readonly StarterId[] = [
  'monolith',
  'microservices',
  'event-driven',
  'hexagonal',
  'cqrs',
];

/** `PRIMARY_STARTER_IDS` resolved, in that order, skipping any id the catalog no longer has. */
export const PRIMARY_STARTERS: readonly ArchitectureStarter[] = PRIMARY_STARTER_IDS.flatMap(
  (id) => BY_ID.get(id) ?? [],
);
