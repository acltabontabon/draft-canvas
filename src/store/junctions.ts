/**
 * Linked Junctions as the canvas reads them: how many other places a group is drawn in.
 *
 * Asked by every Junction on every store update, so the answer is two map lookups. The room on
 * screen (with any rooms inside it) is indexed once per change to its shapes; the rest of the file
 * is counted once per room entered, because `outer` only changes when you move or someone else
 * edits. Nothing here is state: it is read from the document and kept only as long as the document
 * it was read from.
 */
import { pathKey, type DepthPath } from '../depth/tree';
import type { DraftDocument, DraftNode } from '../document/types';
import { junctionIndex } from '../junctions/groups';

interface FileState {
  document: DraftDocument;
  path: DepthPath;
  outer: DraftDocument | null;
}

const NOTHING_ELSEWHERE: ReadonlyMap<string, number> = new Map();

/** Per `outer` file: the room it was last asked about, and each group's members outside that room. */
const elsewhereCache = new WeakMap<readonly DraftNode[], { key: string; counts: ReadonlyMap<string, number> }>();

/** Built at module level: the returned map holds counts and nothing of the walk that made it. */
function countElsewhere(outer: DraftDocument, path: DepthPath): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const [link, members] of junctionIndex(outer).groups) {
    let count = 0;
    for (const member of members) {
      // `outer` still holds the room on screen as it was when it was entered; that room, and the
      // rooms inside it, are counted from the live document instead.
      const within = member.path.length >= path.length && path.every((id, index) => member.path[index] === id);
      if (!within) count += 1;
    }
    if (count > 0) counts.set(link, count);
  }
  return counts;
}

function elsewhere(state: FileState): ReadonlyMap<string, number> {
  if (state.path.length === 0 || !state.outer) return NOTHING_ELSEWHERE;
  const key = pathKey(state.path);
  const cached = elsewhereCache.get(state.outer.nodes);
  if (cached && cached.key === key) return cached.counts;
  const counts = countElsewhere(state.outer, state.path);
  elsewhereCache.set(state.outer.nodes, { key, counts });
  return counts;
}

/**
 * How many other Junctions share `link`, anywhere in the file. `0` for a Junction still waiting for
 * its counterpart, and for no link at all.
 */
export function junctionPeerCount(state: FileState, link: string | undefined): number {
  if (!link) return 0;
  const here = junctionIndex(state.document).groups.get(link)?.length ?? 0;
  return Math.max(0, here + (elsewhere(state).get(link) ?? 0) - 1);
}
