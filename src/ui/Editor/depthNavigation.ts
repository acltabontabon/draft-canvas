import { flash, focusNodes } from '../../commands/search';
import type { CommandContext } from '../../commands/types';
import { isEditableTarget } from '../../lib/isEditableTarget';
import { prefersReducedMotion } from '../../lib/motion';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { rectOfEntrance, rectOfRoom, type ScreenRect } from './depthRects';

/**
 * Stepping into or out of a shape, from wherever it is asked for — a shortcut, a command, the
 * context menu, the depth map.
 *
 * Two things happen here that the store deliberately does not do. First, whatever is being typed
 * is let go of: a label only reaches the document when its field blurs, and navigating swaps the
 * room the canvas is drawing, so the text would otherwise be committed to a room nobody is looking
 * at. Second, the shape's rectangle is measured *before* the move and handed to the transition, so
 * the room can appear to grow out of the shape it belongs to — a picture of what just happened,
 * played after the fact, which nothing else waits on.
 *
 * Kept out of `EditorScreen.tsx` so that file exports only its component, which is what keeps Fast
 * Refresh working for the editor.
 */
async function commitEditing(): Promise<void> {
  const active = document.activeElement;
  if (!isEditableTarget(active)) return;
  (active as HTMLElement).blur();
  // One tick for React to run the blur handler that writes the text.
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

function play(direction: 'in' | 'out', nodeId: string, from: ScreenRect | null): void {
  if (prefersReducedMotion()) return;
  useUiStore.getState().setDepthTransition({ id: Date.now(), direction, nodeId, from });
}

/** Step into a shape's own architecture. */
export async function lookInside(nodeId: string): Promise<void> {
  await commitEditing();
  const entrance = rectOfEntrance(nodeId);
  if (!useEditorStore.getState().enterInside(nodeId)) return;
  if (entrance) play('in', nodeId, entrance);
}

/** Climb back out — one room by default, or all the way out to `depth`. */
export async function backOut(depth?: number): Promise<void> {
  await commitEditing();
  const state = useEditorStore.getState();
  if (state.path.length === 0) return;
  const target = depth ?? state.path.length - 1;
  const owner = state.path[target];
  // Measured while it is still on screen: the climb closes from this frame onto the shape.
  const room = rectOfRoom();
  state.exitTo(target);
  // Refused (a drag or a resize is still under way): nothing moved, so nothing is selected or played.
  const after = useEditorStore.getState();
  if (!owner || after.path.length !== target) return;
  // The shape this room belongs to is back on screen, and the room closes onto it — followed frame
  // by frame, since the camera is still on its way there. It is left selected so ⌘↓ goes straight
  // back in — except while presenting, where a selection ring is not part of the picture.
  if (after.mode !== 'present') after.setSelection({ nodes: [owner], edges: [] });
  play('out', owner, room);
}

/**
 * Go to one element and make it obvious — wherever in the file it lives.
 *
 * The composition that was missing. `focusNodes` + `flash` has always been able to reach
 * something in the room you are standing in (it is how the palette's jump rows work), and
 * `lookInside`/`backOut` has always been able to change rooms; nothing put the two together, so
 * "go to the connector this action came from" had no answer when the connector was two rooms
 * down.
 *
 * The context is rebuilt rather than passed in, because the camera has to be aimed at the room
 * that is on screen *after* the climb, not the one that was there when the row was clicked.
 */
export async function navigateToElement(
  target: { kind: 'node' | 'edge'; id: string; path: readonly string[] },
  buildContext: () => CommandContext,
): Promise<void> {
  const from = useEditorStore.getState().path;
  let shared = 0;
  while (shared < from.length && shared < target.path.length && from[shared] === target.path[shared]) shared += 1;

  // Out to the deepest room both paths share, then down the rest of the way. Each step is the
  // ordinary navigation, so the room transitions play exactly as they do by hand.
  if (from.length > shared) await backOut(shared);
  for (let depth = shared; depth < target.path.length; depth += 1) {
    await lookInside(target.path[depth]!);
  }

  // The climb refused (a drag was still under way, or a room stopped resolving): aiming the
  // camera at a room nobody is standing in would be worse than not moving at all.
  if (useEditorStore.getState().path.length !== target.path.length) return;

  const ctx = buildContext();
  const document = ctx.editor.document;
  if (target.kind === 'node') {
    if (!document.nodes.some((node) => node.id === target.id)) return;
    ctx.editor.setSelection({ nodes: [target.id], edges: [] });
    focusNodes(ctx, [target.id]);
  } else {
    const edge = document.edges.find((candidate) => candidate.id === target.id);
    if (!edge) return;
    ctx.editor.setSelection({ nodes: [], edges: [target.id] });
    // A connector has no box of its own, so the camera frames what it runs between.
    focusNodes(ctx, [edge.source, edge.target]);
  }
  flash(ctx, target.id);
}
