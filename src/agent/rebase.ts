import type { DraftDocument, DraftEdge, DraftFlow, DraftNode } from '../document/types';

/**
 * `update_diagram`'s `onConflict: "rebase"`: an agent working while the person edits the same diagram
 * would otherwise meet `REVISION_CONFLICT` on every request, because every keystroke is a new revision.
 * A batch worked out against the revision the agent last read may still be applied to the current one
 * when nothing it changed was changed by the person meanwhile — the two edits are then independent, and
 * applying one after the other is what applying them in either order gives. Anything they share is a
 * real conflict and is refused as before.
 */

type Room = { nodes: DraftNode[]; edges: DraftEdge[]; flows: DraftFlow[]; level?: string };

/** Every node, connector and flow in the file, in every room, keyed by id, as comparable text. A node's
 *  own fields only: what is inside it is its own room, compared on its own. The rest an agent's batch
 *  can change is keyed too — each room's level, the root-only open points and the title — or a rebase
 *  would apply over the person's change to one of them as though the two edits were independent. */
function contentsOf(file: DraftDocument): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (room: Room, owner: string) => {
    out.set(`level:level@${owner}`, room.level ?? '');
    for (const node of room.nodes) {
      const { inside, ...own } = node;
      out.set(`node:${node.id}`, JSON.stringify(own));
      if (inside) visit(inside, node.id);
    }
    for (const edge of room.edges) out.set(`edge:${edge.id}`, JSON.stringify(edge));
    for (const flow of room.flows) out.set(`flow:${flow.id}`, JSON.stringify(flow));
  };
  visit(file, 'root');
  for (const point of file.openPoints) out.set(`point:${point.id}`, JSON.stringify(point));
  out.set('meta:title', file.metadata.title);
  return out;
}

/** Ids added, removed or changed between two versions of a file. */
export function changedIds(before: DraftDocument, after: DraftDocument): Set<string> {
  const a = contentsOf(before);
  const b = contentsOf(after);
  const changed = new Set<string>();
  for (const [key, value] of a) if (b.get(key) !== value) changed.add(key.slice(key.indexOf(':') + 1));
  for (const key of b.keys()) if (!a.has(key)) changed.add(key.slice(key.indexOf(':') + 1));
  return changed;
}

/** What both sides changed: empty means the agent's batch may be applied on top of the person's edits. */
export function overlapOf(base: DraftDocument, theirs: DraftDocument, ours: DraftDocument): string[] {
  const person = changedIds(base, theirs);
  return [...changedIds(base, ours)].filter((id) => person.has(id));
}

/**
 * What the batch, re-run on the person's current file, changed among what the person changed since
 * `base`. `overlapOf` only sees what the batch does to the file it was written against; re-run on the
 * current one it can cascade into the person's new work — removing a shape takes the connector they
 * just drew to it, the open point they pinned on it, or the shape they put inside it — none of which
 * was in `base` to compare. Empty means the re-run left all of their work alone.
 */
export function rebasedOverlapOf(base: DraftDocument, theirs: DraftDocument, rebased: DraftDocument): string[] {
  const person = changedIds(base, theirs);
  return [...changedIds(theirs, rebased)].filter((id) => person.has(id));
}

/**
 * The snapshots behind revisions recently handed to agents for the open document, so a rebase can see
 * what an agent's batch was written against. A handful is plenty: an agent rebuilds against its latest
 * read, and an older base falls back to an ordinary conflict.
 */
export class BaseSnapshots {
  private readonly held = new Map<string, DraftDocument>();
  private readonly capacity: number;

  constructor(capacity = 6) {
    this.capacity = capacity;
  }

  remember(revision: string, file: DraftDocument): void {
    this.held.delete(revision);
    this.held.set(revision, file);
    while (this.held.size > this.capacity) this.held.delete(this.held.keys().next().value!);
  }

  get(revision: string): DraftDocument | undefined {
    return this.held.get(revision);
  }

  clear(): void {
    this.held.clear();
  }
}
