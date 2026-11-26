/**
 * A small picture of where a Junction continues: the Junction and its context, drawn by the same
 * renderer as an export, in the diagram's own style and theme.
 *
 * Only the handful of shapes in the context are handed to the renderer — never the room — so the
 * cost is the same on a diagram of five shapes and one of five thousand. Pictures are kept for the
 * last few places looked at and thrown away the moment the room they were drawn from changes: a
 * room's shape and connector lists get new identities when anything in it is edited, by this person
 * or anyone else, so comparing them is the whole invalidation.
 */
import type { DraftDocument, DraftNode } from '../document/types';
import type { JunctionContext } from '../junctions/destination';
import { renderDocumentSvg } from '../render/svg/document';
import type { ResolvedStyle } from '../render/style/resolve';
import type { ThemeName } from '../render/theme/tokens';

export interface JunctionPicture {
  svg: string;
  width: number;
  height: number;
  /** The Junction's own box inside the picture, in the picture's units — where to point. */
  focus: { x: number; y: number; width: number; height: number };
}

interface Kept {
  nodes: readonly DraftNode[];
  edges: DraftDocument['edges'];
  style: ResolvedStyle;
  theme: ThemeName;
  picture: JunctionPicture;
}

/** How many pictures are kept. A group's destinations are looked at one after another, then left. */
export const PICTURE_LIMIT = 16;
const PADDING = 18;

/** Insertion order is age: the first key is the one looked at longest ago. */
const kept = new Map<string, Kept>();

function current(entry: Kept | undefined, room: DraftDocument, style: ResolvedStyle, theme: ThemeName): entry is Kept {
  return entry !== undefined && entry.nodes === room.nodes && entry.edges === room.edges && entry.style === style && entry.theme === theme;
}

/** The picture already drawn for this Junction, if the room has not changed since. */
export function keptPicture(id: string, room: DraftDocument, style: ResolvedStyle, theme: ThemeName): JunctionPicture | undefined {
  const entry = kept.get(id);
  return current(entry, room, style, theme) ? entry.picture : undefined;
}

/**
 * Draws (or returns) the picture for the Junction `context.node` in `room`. Synchronous and small:
 * callers that open on a hover ask for it after the card is on screen, not before.
 */
export function junctionPicture(room: DraftDocument, context: JunctionContext, style: ResolvedStyle, theme: ThemeName): JunctionPicture {
  const id = context.node.id;
  const entry = kept.get(id);
  if (current(entry, room, style, theme)) {
    // Looked at again: youngest once more.
    kept.delete(id);
    kept.set(id, entry);
    return entry.picture;
  }
  const ids = new Set(context.contextIds);
  const edgeIds = new Set(context.edgeIds);
  // The context alone, as a document of its own: what the renderer never sees, it never lays out.
  const scene: DraftDocument = {
    ...room,
    nodes: room.nodes.filter((node) => ids.has(node.id)),
    edges: room.edges.filter((edge) => edgeIds.has(edge.id)),
    flows: [],
    openPoints: [],
  };
  delete scene.ink;
  const rendered = renderDocumentSvg(scene, {
    theme,
    style,
    padding: PADDING,
    transparent: true,
    includeBackground: false,
    openPoints: false,
    ink: false,
    idScope: `junction-${id}`,
  });
  const picture: JunctionPicture = {
    svg: rendered.svg,
    width: rendered.width,
    height: rendered.height,
    focus: { x: context.node.x - rendered.origin.x, y: context.node.y - rendered.origin.y, width: context.node.width, height: context.node.height },
  };
  kept.delete(id);
  kept.set(id, { nodes: room.nodes, edges: room.edges, style, theme, picture });
  while (kept.size > PICTURE_LIMIT) kept.delete(kept.keys().next().value!);
  return picture;
}

/** How many pictures are held right now. For tests of the bound. */
export function keptPictureCount(): number {
  return kept.size;
}

/** Forgets every picture: the diagram on screen was replaced by another. */
export function forgetPictures(): void {
  kept.clear();
}
