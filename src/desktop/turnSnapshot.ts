/**
 * Whether a diagram is just as a conversation's last turn left it, so that turn's agent can skip
 * reading it again: a read is a round trip, and its whole answer, every turn. The same parts (not
 * only the same camera, which a pan changes), the same room, the same agent's session; and only on a
 * follow-up, never a conversation's first turn. Kept per diagram for this window, never saved.
 */
interface Sent {
  parts: readonly unknown[];
  room: string;
  agent: string;
}

const sent = new Map<string, Sent>();

export function unchangedSinceLastTurn(diagramId: string, view: { nodes: unknown; edges: unknown; flows: unknown; openPoints?: unknown }, room: readonly string[], agent: string, following: boolean): boolean {
  const now: Sent = { parts: [view.nodes, view.edges, view.flows, view.openPoints], room: room.join('/'), agent };
  const before = sent.get(diagramId);
  sent.set(diagramId, now);
  return following && before !== undefined && before.room === now.room && before.agent === now.agent && before.parts.every((part, i) => part === now.parts[i]);
}

/** A conversation started over: its next turn reads afresh. */
export function forgetTurnSnapshot(diagramId: string): void {
  sent.delete(diagramId);
}
