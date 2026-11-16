import { useState } from 'react';

const NO_IDS: ReadonlySet<string> = new Set();

const toSet = (ids: readonly string[]): ReadonlySet<string> => (ids.length === 0 ? NO_IDS : new Set(ids));

/**
 * The selection's ids as a set that keeps its identity while the ids are the same. React Flow
 * reports a selection as fresh arrays even when nothing changed (`onSelectionChange` rebuilds the
 * edge list on every click), and a new set re-projected the whole canvas.
 *
 * Judged only when the array itself is a new one, and then member by member against the set already
 * handed out — no string is joined on any render, the usual one (a drag frame, an unchanged
 * selection) being an identity check. The answer is kept in state, adjusted while rendering — the
 * way React derives state from what it is given — so nothing reads a ref during a render.
 */
export function useIdSet(ids: readonly string[]): ReadonlySet<string> {
  const [held, setHeld] = useState(() => ({ ids, set: toSet(ids) }));
  if (held.ids === ids) return held.set;
  const set = held.set.size === ids.length && ids.every((id) => held.set.has(id)) ? held.set : toSet(ids);
  setHeld({ ids, set });
  return set;
}
