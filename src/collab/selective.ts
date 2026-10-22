/**
 * Undo and redo while other people are editing the same file.
 *
 * Alone, undo puts a whole-file snapshot back. Together, that would also take back everything anyone
 * else did since — so instead each history entry remembers what it touched (`changeKeys`), and
 * stepping back reverts exactly those things, and only where they still hold what this edit left
 * there. Something another person changed since is theirs now and is left alone; an undo that would
 * have to take away something another person built on it (a connector to the shape being un-added)
 * is refused rather than taking it.
 */
import type { DraftDocument } from '../document/types';
import { applyChanges } from './apply';
import { keyOf, ROOT_ROOM, type Change } from './changes';
import { diffFile, nodeValue, wireSettings } from './diff';
import { sameExcept, sameValue } from './equal';
import { indexOf } from './fileIndex';
import { repairReferences } from './repair';

/** Everything an edit from `before` to `after` touched, nested contents of what it removed included. */
export function changeKeys(before: DraftDocument, after: DraftDocument): string[] {
  return [...new Set(diffFile(before, after, { implied: true }).map(keyOf))];
}

export interface SelectiveStep {
  /** The file after the step, or `current` itself when nothing could be taken back. */
  file: DraftDocument;
  /** Some of what the step would have reverted has been changed by somebody else since. */
  partial: boolean;
  /** Reverting would have removed something somebody else made; nothing was changed. */
  blocked: boolean;
}

/**
 * Takes `current` from what an entry left (`from`) back to what it found (`to`), for the `keys` the
 * entry touched. Undo passes `(entry.after, entry.before)`; redo the other way round.
 */
export function revertKeys(current: DraftDocument, from: DraftDocument, to: DraftDocument, keys: readonly string[]): SelectiveStep {
  return revertEach(current, keys.map((key) => ({ key, left: from, found: to })));
}

/** One thing to take back: `key`, from what an edit left there to what it found there. */
export interface KeyRevert {
  key: string;
  /** The file just after the last edit that touched `key`. */
  left: DraftDocument;
  /** The file just before the first edit that touched it. */
  found: DraftDocument;
}

/**
 * `revertKeys` for things touched at different times — one person's edits across a session, each
 * shape with its own before and after. The same rules: only where `current` still holds what was
 * left, and nothing that would take away something outside `reverts` (another person's connector to
 * a shape being un-added).
 */
export function revertEach(current: DraftDocument, reverts: readonly KeyRevert[]): SelectiveStep {
  const wanted = new Set(reverts.map((revert) => revert.key));
  // One diff per pair of files, however many keys share it.
  const diffs = new Map<DraftDocument, Map<DraftDocument, Change[]>>();
  const diffOf = (left: DraftDocument, found: DraftDocument) => {
    let byFound = diffs.get(left);
    if (!byFound) diffs.set(left, (byFound = new Map()));
    let changes = byFound.get(found);
    if (!changes) byFound.set(found, (changes = diffFile(left, found, { implied: true })));
    return changes;
  };
  const kept: Change[] = [];
  let partial = false;
  for (const revert of reverts) {
    const changes = diffOf(revert.left, revert.found).filter((change) => keyOf(change) === revert.key);
    if (changes.length === 0) continue;
    if (sameAt(current, revert.left, revert.key)) kept.push(...changes);
    else partial = true;
  }
  if (kept.length === 0) return { file: current, partial, blocked: false };

  const result = repairReferences(applyChanges(current, kept));
  // Anything else the step would change is somebody else's work hanging off it: a connector to the
  // shape being un-added (repair), a shape put inside it (its room goes with it).
  const extra = changeKeys(current, result).filter((key) => !wanted.has(key));
  if (extra.length > 0) return { file: current, partial, blocked: true };
  return { file: result, partial, blocked: false };
}

/** Whether `current` still holds, for `key`, exactly what `left` holds — the edit's result untouched. */
export function sameAt(current: DraftDocument, left: DraftDocument, key: string): boolean {
  const colon = key.indexOf(':');
  const kind = colon === -1 ? key : key.slice(0, colon);
  const rest = colon === -1 ? '' : key.slice(colon + 1);
  const a = indexOf(current);
  const b = indexOf(left);
  switch (kind) {
    case 'node': {
      const x = a.nodes.get(rest);
      const y = b.nodes.get(rest);
      if (!x || !y) return !x && !y;
      return x.room === y.room && sameExcept(nodeValue(x.value) as unknown as Record<string, unknown>, nodeValue(y.value) as unknown as Record<string, unknown>, 'inside');
    }
    case 'edge':
    case 'flow': {
      const x = (kind === 'edge' ? a.edges : a.flows).get(rest);
      const y = (kind === 'edge' ? b.edges : b.flows).get(rest);
      if (!x || !y) return !x && !y;
      return x.room === y.room && sameValue(x.value, y.value);
    }
    case 'point':
      return sameValue(current.openPoints.find((p) => p.id === rest), left.openPoints.find((p) => p.id === rest));
    case 'title':
      return current.metadata.title === left.metadata.title;
    case 'settings':
      return sameValue(wireSettings(current.settings), wireSettings(left.settings));
    case 'level':
      return (a.rooms.get(rest)?.graph.level ?? null) === (b.rooms.get(rest)?.graph.level ?? null);
    case 'order': {
      const split = rest.lastIndexOf(':');
      const room = rest.slice(0, split);
      const collection = rest.slice(split + 1);
      const ids = (file: DraftDocument, index: typeof a) => {
        if (collection === 'points') return room === ROOT_ROOM ? file.openPoints.map((p) => p.id) : [];
        const graph = index.rooms.get(room)?.graph;
        return graph ? (graph[collection as 'nodes' | 'edges' | 'flows'] as { id: string }[]).map((item) => item.id) : [];
      };
      return sameValue(ids(current, a), ids(left, b));
    }
    default:
      return false;
  }
}
