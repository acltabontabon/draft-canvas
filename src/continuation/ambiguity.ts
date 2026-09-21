import type { DraftDocument, ViewLevel } from '../document/types';
import { neighborhoodOf } from './context';
import type { Neighborhood } from './types';

/**
 * Where continuation deliberately won't guess — written down, so that `]` on one of these answers
 * with *why* (and a picker to choose from) instead of doing nothing.
 *
 * Every entry is an anchor that asking (`]`) leaves with no candidate at all, because more than
 * one next move is equally valid and nothing in the graph picks between them. Silence is the
 * right call for the *engine* — a wrong suggestion costs more than none — but not for the person
 * who asked, so the editor opens the Quick Connect picker at the anchor with the entry's `reason`
 * above it. Nothing here adds, removes or reorders a candidate.
 *
 * Hand-written like every reason in `rules.ts`: which shapes are genuinely ambiguous is a
 * judgement. An entry is not permanent — when the document gains a real signal that tells the
 * readings apart (a Data Store role, the way `deliveryRole` tells a dead-letter queue from a queue),
 * the entry becomes a rule instead. `table-next-stage` is exactly that for one reading of a Table:
 * a Table another store already feeds is a pipeline stage, and gets a suggestion.
 *
 * First match wins, so a narrower entry sits above the broader one it refines (Table above Data
 * Store). `tests/continuation.test.ts` checks every shape `]` leaves empty has an entry here, and
 * the table in `docs/reference/semantics.md` against this list.
 */
export interface Ambiguity {
  /** Stable id: named in tests and the docs table. */
  id: string;
  /** The shape, as the docs table names it. */
  label: string;
  matches(nb: Neighborhood): boolean;
  /** One sentence shown above the picker — why there is no suggestion, never what to do instead. */
  reason: string;
}

export const AMBIGUOUS: readonly Ambiguity[] = [
  {
    id: 'overview',
    label: 'Infrastructure in a System Context view',
    // Not ambiguous so much as out of altitude: every infrastructure rule goes quiet in a view that
    // has been called a system overview (`rules.ts`'s `NOT_IN_AN_OVERVIEW`). An External System is
    // at home there, so it keeps its own answer below.
    matches: (nb) => nb.level === 'context' && nb.category !== 'external',
    reason: 'This view is a system overview — what comes after this belongs a level down.',
  },
  {
    id: 'table',
    label: 'Table',
    // The Transactional Outbox's outbox and the business table beside it are the same shape in
    // the same boundary, written by the same service; only their labels differ. No rule reads
    // labels, so an outbox relay (Table → Worker) is never suggested for either.
    matches: (nb) => nb.node.type === 'database' && nb.node.databaseKind === 'table',
    reason: 'A table could be an outbox, a read model or plain business data — nothing here says which.',
  },
  {
    id: 'data-store',
    label: 'Data Store',
    matches: (nb) => nb.category === 'database',
    reason: 'What comes after a data store depends on who reads it — a service, a worker or a replica.',
  },
  {
    id: 'cache',
    label: 'Cache',
    matches: (nb) => nb.category === 'cache',
    reason: 'A cache is usually where a path ends — anything after it is your call.',
  },
  {
    id: 'file-system',
    label: 'File System',
    matches: (nb) => nb.category === 'fileSystem',
    reason: 'Files here could feed a job, a service or nothing at all.',
  },
  {
    id: 'search-index',
    label: 'Search Index',
    matches: (nb) => nb.category === 'searchIndex',
    reason: 'A search index is usually where a path ends — anything after it is your call.',
  },
  {
    id: 'dead-letter',
    label: 'Dead-letter queue',
    matches: (nb) => nb.category === 'deadLetter',
    reason: 'Re-driving dead letters is a choice, not a default — many never leave the queue.',
  },
  {
    id: 'external',
    label: 'External System',
    matches: (nb) => nb.category === 'external',
    reason: 'What a system someone else runs talks to is mostly outside this diagram.',
  },
  {
    id: 'component',
    label: 'Component',
    matches: (nb) => nb.category === 'component',
    reason: 'A controller, a use case and a repository all look alike — nothing here says which this is.',
  },
];

/** Why `nb`'s anchor gets no suggestion, if that is written down — see `AMBIGUOUS`. */
export function ambiguityFor(nb: Neighborhood): Ambiguity | undefined {
  return AMBIGUOUS.find((entry) => entry.matches(nb));
}

/** `ambiguityFor` by node id — what the editor asks when `]` came back empty. */
export function ambiguityOf(doc: DraftDocument, anchorId: string, level?: ViewLevel): Ambiguity | undefined {
  const nb = neighborhoodOf(doc, anchorId, level);
  return nb && ambiguityFor(nb);
}
