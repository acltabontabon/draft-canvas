/**
 * Strongly connected components of a directed graph: which parts can all reach each other, so a
 * loop is one place rather than a walk that never ends. The one implementation, read by the
 * architecture model's cycles (`graph.ts`) and by how work travels (`traffic/analyze.ts`).
 */

export interface Component {
  members: string[];
  /** More than one member, or a single member that points at itself. */
  loop: boolean;
}

/**
 * Iterative Tarjan, so a deep chain can't exhaust the call stack. `adjacency` holds each id's
 * targets in the order they are to be walked; a target with no entry of its own is not part of the
 * graph and is passed over. Components come sources first, members sorted.
 */
export function stronglyConnected(ids: readonly string[], adjacency: ReadonlyMap<string, readonly string[]>): { components: Component[]; componentOf: Map<string, number> } {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: Component[] = [];
  let next = 0;

  for (const root of ids) {
    if (index.has(root)) continue;
    const frames: { node: string; edge: number }[] = [{ node: root, edge: 0 }];
    index.set(root, next);
    low.set(root, next);
    next += 1;
    stack.push(root);
    onStack.add(root);
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const neighbours = adjacency.get(frame.node) ?? [];
      if (frame.edge < neighbours.length) {
        const neighbour = neighbours[frame.edge++]!;
        if (!adjacency.has(neighbour)) continue;
        if (!index.has(neighbour)) {
          index.set(neighbour, next);
          low.set(neighbour, next);
          next += 1;
          stack.push(neighbour);
          onStack.add(neighbour);
          frames.push({ node: neighbour, edge: 0 });
        } else if (onStack.has(neighbour)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(neighbour)!));
        }
        continue;
      }
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
      if (low.get(frame.node) !== index.get(frame.node)) continue;
      const members: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        members.push(member);
      } while (member !== frame.node);
      members.sort(compareText);
      const selfLoop = members.length === 1 && adjacency.get(members[0]!)!.includes(members[0]!);
      components.push({ members, loop: members.length > 1 || selfLoop });
    }
  }
  // Tarjan emits components in reverse topological order; reversing gives sources first.
  components.reverse();
  const componentOf = new Map<string, number>();
  components.forEach((component, position) => component.members.forEach((id) => componentOf.set(id, position)));
  return { components, componentOf };
}

/** Code-unit order: the same on every machine, whatever its locale. */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
