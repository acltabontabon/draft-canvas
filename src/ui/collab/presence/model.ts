import type { FollowState, PeerView, Point, Presence } from '../../../collab/protocol';
import type { DepthPath } from '../../../depth/tree';

/**
 * What presence means on this end: the value this copy publishes, and which of the others' values
 * the canvas on screen should draw. Pure — the hooks and the layer only wire these to the stores.
 */

/** Presence names a room by its owner's id, the document itself by `''` (`Presence.room`). */
export function roomOf(path: DepthPath): string {
  return path.length === 0 ? '' : path[path.length - 1]!;
}

/**
 * `readPresence` refuses a selection longer than this, and with it the whole message — the cursor
 * would vanish along with the selection. Past it, the selection is sent as none: presence is a
 * hint of where someone is working, not a copy of what they hold.
 */
export const MAX_SHARED_SELECTION = 500;

function capped(ids: readonly string[]): string[] {
  return ids.length > MAX_SHARED_SELECTION ? [] : [...ids];
}

/** A tenth of a flow unit is finer than any screen shows at the deepest zoom; rounding to it keeps
 *  sub-pixel jitter from counting as a move. */
function rounded(point: Point): Point {
  return { x: Math.round(point.x * 10) / 10, y: Math.round(point.y * 10) / 10 };
}

export function presenceOf(input: {
  path: DepthPath;
  pointer: Point | null;
  selection: { nodes: readonly string[]; edges: readonly string[] };
  editing: string | null;
}): Presence {
  return {
    room: roomOf(input.path),
    pointer: input.pointer ? rounded(input.pointer) : null,
    selection: { nodes: capped(input.selection.nodes), edges: capped(input.selection.edges) },
    editing: input.editing,
  };
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

export function samePresence(a: Presence, b: Presence): boolean {
  return (
    a.room === b.room &&
    a.editing === b.editing &&
    (a.pointer === b.pointer || (!!a.pointer && !!b.pointer && a.pointer.x === b.pointer.x && a.pointer.y === b.pointer.y)) &&
    sameIds(a.selection.nodes, b.selection.nodes) &&
    sameIds(a.selection.edges, b.selection.edges)
  );
}

export function sameFollow(a: FollowState | null, b: FollowState | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.presenting === b.presenting &&
    a.flowId === b.flowId &&
    a.step === b.step &&
    a.viewport.x === b.viewport.x &&
    a.viewport.y === b.viewport.y &&
    a.viewport.zoom === b.viewport.zoom &&
    // A resized presenter window changes what a smaller follower has to fit.
    a.view?.width === b.view?.width &&
    a.view?.height === b.view?.height &&
    sameIds(a.path, b.path)
  );
}

/** Someone else in the session, as the canvas draws them. */
export interface PeerPresence {
  id: string;
  name: string;
  /** Index into the peer palette, already folded into 0–7. */
  color: number;
  /** A connection in trouble: drawn faintly, as `PeerBadge` dims. */
  faint: boolean;
  presence: Presence;
}

/**
 * The people whose presence belongs on the canvas showing `room`: in the same room, still in the
 * session, and not gone. Ordered as the peer list is, so a ring's place among several on one shape
 * never shuffles when someone moves.
 */
export function peersInRoom(
  peers: readonly PeerView[],
  presence: Readonly<Record<string, Presence>>,
  room: string,
): PeerPresence[] {
  const shown: PeerPresence[] = [];
  for (const peer of peers) {
    const where = Object.prototype.hasOwnProperty.call(presence, peer.id) ? presence[peer.id] : undefined;
    if (!where || where.room !== room || peer.link === 'gone') continue;
    shown.push({ id: peer.id, name: peer.name, color: ((peer.color % 8) + 8) % 8, faint: peer.link !== 'live', presence: where });
  }
  return shown;
}

/** Shapes and connectors ringed for one person's selection, and for everyone's together. */
export const MAX_HELD_DRAWN_EACH = 40;
export const MAX_HELD_DRAWN = 120;

/** Who holds each shape or connector, in peer order — what the rings are drawn from. */
export interface Holdings {
  nodes: Map<string, PeerPresence[]>;
  edges: Map<string, PeerPresence[]>;
  /** Shape id → the person typing in it. One is enough to say so; the first wins. */
  editing: Map<string, PeerPresence>;
}

export function holdingsOf(shown: readonly PeerPresence[]): Holdings {
  const nodes = new Map<string, PeerPresence[]>();
  const edges = new Map<string, PeerPresence[]>();
  const editing = new Map<string, PeerPresence>();
  const add = (into: Map<string, PeerPresence[]>, id: string, peer: PeerPresence) => {
    const list = into.get(id);
    if (!list) into.set(id, [peer]);
    else if (!list.includes(peer)) list.push(peer);
  };
  let budget = MAX_HELD_DRAWN;
  for (const peer of shown) {
    // Each ring is a traced silhouette, redrawn on every presence update; a selection of hundreds,
    // sent many times a second, would keep this person's canvas redrawing. Past the first few the
    // rest go unringed — presence says where someone works, not everything they hold.
    const allowance = Math.min(budget, MAX_HELD_DRAWN_EACH);
    const heldNodes = peer.presence.selection.nodes.slice(0, allowance);
    const heldEdges = peer.presence.selection.edges.slice(0, allowance - heldNodes.length);
    budget -= heldNodes.length + heldEdges.length;
    for (const id of heldNodes) add(nodes, id, peer);
    for (const id of heldEdges) add(edges, id, peer);
    const typing = peer.presence.editing;
    if (typing !== null) {
      // Typing in a shape holds it, selected or not.
      add(nodes, typing, peer);
      if (!editing.has(typing)) editing.set(typing, peer);
    }
  }
  return { nodes, edges, editing };
}

/** The session's owner — the only one who can present (`publishPresenter` is the host's). */
export function presenterOf(peers: readonly PeerView[]): PeerView | undefined {
  return peers.find((peer) => peer.role === 'owner');
}
