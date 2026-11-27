/**
 * The check an imported history passes before it becomes usable, over any `VersionStore` — the
 * desktop's staging repository uses it; the browser's import does the same walk on isomorphic-git
 * directly (`browser/bundleIo.ts`).
 *
 * Every revision any accepted ref reaches must read as exactly one diagram (`readSnapshot` refuses
 * any other tree) that `validateText` accepts; milestones must tag revisions. Bounded by the
 * history limits, so a hostile bundle cannot make this walk forever.
 *
 * A milestone is found through its ref (`listTags`), so milestones are checked on a store that has
 * their refs: the desktop's staging repository has none until it is committed. `seen` carries the
 * revisions already checked from one call to the next, and its size is what is returned.
 */
import { HISTORY_LIMITS, HistoryError, type Oid, type RefEntry, type VersionStore } from './contracts';
import { MILESTONE_PREFIX } from './refs';

export async function verifyImported(store: VersionStore, refs: RefEntry[], validateText: (text: string) => void, seen: Set<Oid> = new Set()): Promise<number> {
  const stack: Oid[] = [];
  const tags = refs.some((entry) => entry.ref.startsWith(MILESTONE_PREFIX)) ? await store.listTags(MILESTONE_PREFIX) : [];
  for (const entry of refs) {
    if (entry.ref.startsWith(MILESTONE_PREFIX)) {
      const tag = tags.find((candidate) => candidate.ref === entry.ref && candidate.oid === entry.oid);
      if (!tag) throw new HistoryError('invalid', 'A milestone in this bundle is not a tagged revision.');
      stack.push(tag.target);
    } else {
      stack.push(entry.oid);
    }
  }
  const blobs = new Set<string>();
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (seen.size > HISTORY_LIMITS.maxWalk) throw new HistoryError('too-large', 'This history has more revisions than Draft Canvas imports.');
    const commit = await store.readCommit(oid);
    if (!blobs.has(commit.tree)) {
      blobs.add(commit.tree);
      validateText(await store.readSnapshot(oid));
    }
    stack.push(...commit.parents);
  }
  return seen.size;
}
