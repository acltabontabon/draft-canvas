import { isEditableTarget } from '../../lib/isEditableTarget';
import { prefersReducedMotion } from '../../lib/motion';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { rectOfEntrance, rectOfRoom, type ScreenRect } from './depthRects';

/**
 * Stepping into or out of a shape, from wherever it is asked for — a shortcut, a command, the
 * context menu, the trail.
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
