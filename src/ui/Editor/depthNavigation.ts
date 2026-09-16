import { isEditableTarget } from '../../lib/isEditableTarget';
import { prefersReducedMotion } from '../../lib/motion';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';

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

/** Where a node is on screen right now, if it is rendered. */
function rectOfNode(nodeId: string): { x: number; y: number; width: number; height: number } | null {
  const element = document.querySelector(`.react-flow__node[data-id="${CSS.escape(nodeId)}"]`);
  if (!element) return null;
  const { x, y, width, height } = element.getBoundingClientRect();
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

function play(direction: 'in' | 'out', from: { x: number; y: number; width: number; height: number } | null): void {
  if (!from || prefersReducedMotion()) return;
  useUiStore.getState().setDepthTransition({ id: Date.now(), direction, from });
}

/** Step into a shape's own architecture. */
export async function lookInside(nodeId: string): Promise<void> {
  await commitEditing();
  const from = rectOfNode(nodeId);
  if (!useEditorStore.getState().enterInside(nodeId)) return;
  play('in', from);
}

/** Climb back out — one room by default, or all the way out to `depth`. */
export async function backOut(depth?: number): Promise<void> {
  await commitEditing();
  const state = useEditorStore.getState();
  if (state.path.length === 0) return;
  const target = depth ?? state.path.length - 1;
  const owner = state.path[target];
  state.exitTo(target);
  // The shape this room belongs to is back on screen; the room shrinks into it, and it is left
  // selected so ⌘↓ goes straight back in. Its rectangle is only knowable once React has committed
  // the outer room and the camera has been placed, which is a frame or two away — so the animation
  // waits for the shape to actually exist rather than guessing, and gives up rather than stalling.
  if (!owner) return;
  useEditorStore.getState().setSelection({ nodes: [owner], edges: [] });
  void whenRendered(owner).then((rect) => play('out', rect));
}

/** The node's screen rectangle once it is drawn, or null if it has not appeared within a few frames. */
function whenRendered(nodeId: string, framesLeft = 6): Promise<{ x: number; y: number; width: number; height: number } | null> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      const rect = rectOfNode(nodeId);
      if (rect) resolve(rect);
      else if (framesLeft <= 0) resolve(null);
      else resolve(whenRendered(nodeId, framesLeft - 1));
    });
  });
}
