/**
 * What collaborators exchange: changes to a file, one element at a time, keyed by id.
 *
 * Every element in a `.draftcanvas` file already carries an id that is unique across the whole file
 * (`validate.ts` enforces it on read), so a change never has to say *where* something is to say
 * *what* it became — only an element being added needs a room to go into. That is what lets an edit
 * made against a slightly older copy of the file still land on the right element: nothing in a
 * change points at a position that a concurrent edit could have shifted.
 *
 * Rooms are named by the id of the node that owns them (`''` is the document itself) rather than by
 * a path, for the same reason: moving a shape into another room changes the path to everything
 * inside it, but never the id of the shape that owns it.
 *
 * A node's value never includes its `inside`. What is inside a shape is its own room, changed by
 * changes to the elements in it; carrying it along with the node would turn renaming a Service into
 * a copy of every room under it, and two people editing different rooms of the same shape into a
 * conflict.
 */
import type { DraftEdge, DraftFlow, DraftNode, DraftSettings, OpenPoint, ViewLevel } from '../document/types';

/** The id of the node that owns a room, or `''` for the document itself. */
export type RoomId = string;

export const ROOT_ROOM: RoomId = '';

/** A node as a change carries it: everything but the room it owns. */
export type NodeValue = Omit<DraftNode, 'inside'>;

/** The ordered collections a room has, plus the file's own list of open points. */
export type Collection = 'nodes' | 'edges' | 'flows' | 'points';

export type Change =
  /** Adds the node to `room` when it does not exist yet; otherwise replaces it where it already is. `null` removes it, with everything inside it. */
  | { kind: 'node'; id: string; room: RoomId; value: NodeValue | null }
  | { kind: 'edge'; id: string; room: RoomId; value: DraftEdge | null }
  | { kind: 'flow'; id: string; room: RoomId; value: DraftFlow | null }
  /** Open points are the file's, never a room's. */
  | { kind: 'point'; id: string; value: OpenPoint | null }
  /**
   * Moves an existing element into another room. A node keeps what is inside it: moving a shape a
   * level up or down (`moveInside`/`moveOutside`) takes its rooms along, which an add and a remove
   * would have lost.
   */
  | { kind: 'move'; target: 'node' | 'edge' | 'flow'; id: string; room: RoomId }
  | { kind: 'title'; value: string }
  | { kind: 'settings'; value: DraftSettings }
  | { kind: 'level'; room: RoomId; value: ViewLevel | null }
  /**
   * The order of one collection in one room, when it is not simply "what was there, then what was
   * added". Array position is meaningful in a few places (a flow list's order, which connector draws
   * first at equal `z`), so a reorder is a change like any other. Ids it names that are not in the
   * room are ignored, and elements it leaves out keep their place after the ones it names.
   */
  | { kind: 'order'; room: RoomId; collection: Collection; ids: string[] };

export type ChangeKind = Change['kind'];

/**
 * A key naming what a change is about, so two changes about the same thing can be recognised — undo
 * reverting only what an edit touched, a rebase refusing work both sides changed. Elements keep
 * their kind in the key because node, connector and flow ids are separate namespaces.
 */
export function keyOf(change: Change): string {
  switch (change.kind) {
    case 'node':
    case 'edge':
    case 'flow':
      return `${change.kind}:${change.id}`;
    case 'point':
      return `point:${change.id}`;
    case 'move':
      return `${change.target}:${change.id}`;
    case 'title':
      return 'title';
    case 'settings':
      return 'settings';
    case 'level':
      return `level:${change.room}`;
    case 'order':
      return `order:${change.room}:${change.collection}`;
  }
}
