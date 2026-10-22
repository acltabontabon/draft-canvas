/**
 * A shared file as one person sees it: the shared content, with their own camera in every room.
 *
 * Collaborators share what the diagram says, never where each of them is looking. A file arriving
 * from the session carries somebody else's view of every room (or the default one for a room just
 * created), so before it replaces the copy on screen, every room that already existed here keeps
 * the camera it had — and the file keeps its own bookkeeping, everything in `metadata` but the title.
 */
import { mapRooms } from '../depth/tree';
import type { DraftDocument } from '../document/types';
import { ROOT_ROOM } from './changes';
import { diffFile } from './diff';
import { indexOf } from './fileIndex';

/** `incoming` with `current`'s cameras and bookkeeping — `current` itself when nothing shared differs. */
export function withLocalView(incoming: DraftDocument, current: DraftDocument): DraftDocument {
  if (incoming === current || diffFile(current, incoming).length === 0) return current;
  const rooms = indexOf(current).rooms;
  const viewed = mapRooms(incoming, (graph, path) => {
    const mine = rooms.get(path.length === 0 ? ROOT_ROOM : path[path.length - 1]!)?.graph.viewport;
    return mine && mine !== graph.viewport ? { ...graph, viewport: mine } : graph;
  });
  return {
    ...viewed,
    metadata: { ...current.metadata, title: incoming.metadata.title },
  };
}
