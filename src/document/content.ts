/**
 * What of a file is history: the one semantic content model Canvas Evolution records, compares and
 * restores (see docs/reference/evolution.md, "One content model").
 *
 * A `.draftcanvas` file mixes four kinds of state, and history must treat each one deliberately:
 *
 * - **Durable architecture and presentation** — shapes, connectors, rooms, flows (with their step
 *   cameras, which a presenter chose), ink, open points, settings, style, the title. All of it is
 *   history: if any of it changes, a revision records it.
 * - **Volatile bookkeeping** — `metadata.updatedAt`, which every edit restamps. Recording it would
 *   make every capture differ from the last even when nothing was drawn.
 * - **Where someone is looking** — each room's `viewport`. A camera is a person's, not the
 *   diagram's (`collab/diff.ts` never shares it, undo never restores it).
 * - **Transient editing state** — selection, presence, previews, hover. None of it is in a file to
 *   begin with; it lives in `uiStore` and the collaboration session.
 *
 * `historyContent` keeps the first kind exactly and pins the other two to fixed values, so the
 * canonical bytes of two files are equal exactly when their history content is. Capture compares
 * those bytes — never a narrower semantic diff — so no durable field can go unrecorded because a
 * comparison happened not to look at it.
 */
import type { DraftDocument, DraftInside, DraftNode, DraftViewport } from './types';

/** The camera every room has in history: the same everywhere, so it never makes two revisions differ. */
export const HISTORY_VIEWPORT: DraftViewport = Object.freeze({ x: 0, y: 0, zoom: 1 }) as DraftViewport;

function sameViewport(viewport: DraftViewport): boolean {
  return viewport.x === 0 && viewport.y === 0 && viewport.zoom === 1;
}

function pinNodes(nodes: DraftNode[]): DraftNode[] {
  let changed = false;
  const out = nodes.map((node) => {
    if (!node.inside) return node;
    const inside = pinRoom(node.inside);
    if (inside === node.inside) return node;
    changed = true;
    return { ...node, inside };
  });
  return changed ? out : nodes;
}

function pinRoom(room: DraftInside): DraftInside {
  const nodes = pinNodes(room.nodes);
  const viewport = sameViewport(room.viewport) ? room.viewport : HISTORY_VIEWPORT;
  return nodes === room.nodes && viewport === room.viewport ? room : { ...room, nodes, viewport };
}

/**
 * The file as history records it: `updatedAt` pinned to `createdAt` and every room's camera to
 * `HISTORY_VIEWPORT`, everything else untouched and shared by identity. Pure, and idempotent.
 */
export function historyContent(file: DraftDocument): DraftDocument {
  const nodes = pinNodes(file.nodes);
  const viewport = sameViewport(file.viewport) ? file.viewport : HISTORY_VIEWPORT;
  const metadata = file.metadata.updatedAt === file.metadata.createdAt ? file.metadata : { ...file.metadata, updatedAt: file.metadata.createdAt };
  if (nodes === file.nodes && viewport === file.viewport && metadata === file.metadata) return file;
  return { ...file, nodes, viewport, metadata };
}

/**
 * A historical file brought back to the editor: its content, the live file's cameras where both
 * have the room (and the historical default elsewhere), and the live `updatedAt`. Restoring a
 * revision changes what is drawn, never where the person is looking.
 */
export function withLiveBookkeeping(historical: DraftDocument, live: DraftDocument): DraftDocument {
  const cameras = new Map<string, DraftViewport>();
  const collect = (nodes: DraftNode[], prefix: string) => {
    for (const node of nodes) {
      if (!node.inside) continue;
      const key = `${prefix}/${node.id}`;
      cameras.set(key, node.inside.viewport);
      collect(node.inside.nodes, key);
    }
  };
  collect(live.nodes, '');
  const apply = (nodes: DraftNode[], prefix: string): DraftNode[] => {
    if (!nodes.some((node) => node.inside)) return nodes;
    return nodes.map((node) => {
      if (!node.inside) return node;
      const key = `${prefix}/${node.id}`;
      const viewport = cameras.get(key) ?? node.inside.viewport;
      return { ...node, inside: { ...node.inside, viewport, nodes: apply(node.inside.nodes, key) } };
    });
  };
  return {
    ...historical,
    // Identity is the working copy's, never the revision's: a copy made "with history" keeps its own
    // id even when it restores a revision recorded before it was copied.
    metadata: {
      ...historical.metadata,
      id: live.metadata.id,
      createdAt: live.metadata.createdAt,
      updatedAt: live.metadata.updatedAt,
      ...(live.metadata.projectId === undefined ? {} : { projectId: live.metadata.projectId }),
    },
    viewport: live.viewport,
    nodes: apply(historical.nodes, ''),
  };
}
