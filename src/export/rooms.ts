/**
 * Every room of a document, for the exports that read the whole tree rather than the room on
 * screen: the one-image-per-level ZIP (`levels.ts`) and the sequence source (`sequence.ts`).
 *
 * The walk starts at whatever document it is handed — the file at the top, or the room being edited
 * when the dialog exports "inside this shape" — and descends through `depth/tree.ts`'s `viewOf`, so
 * a room is only ever reached the way the store reaches it. Order is tree order, outermost first,
 * which is the order the Depth map lists them in.
 */

import { displayNameFor } from '../document/factory';
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

/** "Checkout / Orders API / Handler" — the document's title, then each owner on the way in. */
export function roomTitleFor(room: ExportRoom): string {
  const title = room.document.metadata.title.trim() || 'Canvas';
  return [title, ...room.owners.map((owner) => displayNameFor(owner))]
    .map((part) => part.replace(/\r\n?|\n/g, ' ').trim())
    .join(' / ');
}
