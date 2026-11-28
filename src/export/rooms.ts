/**
 * Every room of a document, for what reads the whole tree rather than the room on screen: the
 * one-image-per-level ZIP (`levels.ts`), the docs images and what a share link says it carries.
 *
 * The walk starts at whatever document it is handed — the file at the top, or the room being edited
 * when the dialog exports "inside this shape" — and descends through `depth/tree.ts`'s `viewOf`, so
 * a room is only ever reached the way the store reaches it. Order is tree order, outermost first,
 * which is the order the Depth map lists them in.
 */

import { flowIsPlayable } from '../document/flow';
import type { DraftDocument, DraftNode } from '../document/types';
import { hasInside, ROOT_PATH, viewOf, type DepthPath } from '../depth/tree';

export interface ExportRoom {
  path: DepthPath;
  /** The shapes the path names, outermost first — empty at the root. */
  owners: DraftNode[];
  /** The room as an ordinary document, the way every renderer wants it. */
  document: DraftDocument;
}

export function collectRooms(document: DraftDocument): ExportRoom[] {
  const rooms: ExportRoom[] = [{ path: ROOT_PATH, owners: [], document }];
  const descend = (nodes: readonly DraftNode[], path: DepthPath, owners: DraftNode[]) => {
    for (const node of nodes) {
      if (!hasInside(node)) continue;
      const here = [...path, node.id];
      const view = viewOf(document, here);
      if (!view) continue;
      const chain = [...owners, node];
      rooms.push({ path: here, owners: chain, document: view });
      descend(view.nodes, here, chain);
    }
  };
  descend(document.nodes, ROOT_PATH, []);
  return rooms;
}

/** Whether the document holds a room anywhere below the level it shows. */
export function hasRooms(document: DraftDocument): boolean {
  return document.nodes.some(hasInside);
}

/** How many Flows have something to play, across every room: a Flow belongs to the room it was drawn in. */
export function countPlayableFlows(document: DraftDocument): number {
  return collectRooms(document).reduce((sum, room) => sum + room.document.flows.filter((flow) => flowIsPlayable(room.document, flow)).length, 0);
}
