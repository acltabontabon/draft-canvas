import { useEffect } from 'react';
import { useReactFlow, useStoreApi } from '@xyflow/react';
import type { Point } from '../../../collab/protocol';
import { publishPresence } from '../../../store/collabBridge';
import { useCollabStore } from '../../../store/collabStore';
import { useEditorStore } from '../../../store/editorStore';
import { useUiStore } from '../../../store/uiStore';
import { presenceOf, samePresence } from './model';
import { createThrottle } from './throttle';

/** At most 20 presence messages a second: a cursor at 50 ms intervals glides under a CSS transition. */
export const PRESENCE_INTERVAL_MS = 50;

const EDITABLE = 'textarea, input, [contenteditable=""], [contenteditable="true"]';

/** The shape whose inline editor holds focus, if any — a label, a note, a Text element's source. */
function editorShapeOf(target: EventTarget | null): string | null {
  if (!(target instanceof Element) || !target.matches(EDITABLE)) return null;
  return target.closest('.react-flow__node')?.getAttribute('data-id') ?? null;
}

/**
 * Tells everyone else in a session where this person is: their pointer in flow coordinates, their
 * room, their selection and the shape they are typing in. Runs only while a session is live.
 *
 * Nothing here writes a store or renders: the pointer is read from native events on the canvas,
 * kept in a local, and handed to a throttle that sends only what changed, at most every 50 ms,
 * always ending on the latest value. A pan or zoom under a still pointer moves it in flow space,
 * so the camera is watched too. Typing is read from focus as well as `uiStore.editingTextId`,
 * because a shape's label editor is the node view's own state, not the store's.
 */
export function usePresencePublisher(): void {
  const storeApi = useStoreApi();
  const { screenToFlowPosition } = useReactFlow();
  const live = useCollabStore((state) => state.role !== 'off' && state.status === 'live');

  useEffect(() => {
    if (!live) return;
    const throttle = createThrottle(publishPresence, samePresence, PRESENCE_INTERVAL_MS);
    let client: Point | null = null;
    let focusedShape: string | null = null;
    let dom: HTMLElement | null = null;

    const publish = () => {
      const editor = useEditorStore.getState();
      throttle.push(
        presenceOf({
          path: editor.path,
          pointer: client ? screenToFlowPosition(client) : null,
          selection: editor.selection,
          editing: useUiStore.getState().editingTextId ?? focusedShape,
        }),
      );
    };

    const onPointerMove = (event: PointerEvent) => {
      client = { x: event.clientX, y: event.clientY };
      publish();
    };
    const onPointerLeave = () => {
      client = null;
      publish();
    };
    const onFocusIn = (event: FocusEvent) => {
      const shape = editorShapeOf(event.target);
      if (shape === focusedShape) return;
      focusedShape = shape;
      publish();
    };
    const onFocusOut = (event: FocusEvent) => {
      // Focus moving within the same editor (a format bar button inside the node) is still typing.
      const shape = editorShapeOf(event.relatedTarget);
      if (shape === focusedShape) return;
      focusedShape = shape;
      publish();
    };
    const onVisibility = () => {
      if (window.document.visibilityState !== 'hidden') return;
      client = null;
      publish();
    };

    const attach = (next: HTMLElement | null) => {
      if (next === dom) return;
      if (dom) {
        dom.removeEventListener('pointermove', onPointerMove);
        dom.removeEventListener('pointerleave', onPointerLeave);
        dom.removeEventListener('focusin', onFocusIn);
        dom.removeEventListener('focusout', onFocusOut);
      }
      dom = next;
      if (dom) {
        dom.addEventListener('pointermove', onPointerMove, { passive: true });
        dom.addEventListener('pointerleave', onPointerLeave);
        dom.addEventListener('focusin', onFocusIn);
        dom.addEventListener('focusout', onFocusOut);
      }
    };

    let transform = storeApi.getState().transform;
    attach(storeApi.getState().domNode);
    const offFlow = storeApi.subscribe((state) => {
      attach(state.domNode);
      if (state.transform === transform) return;
      transform = state.transform;
      if (client) publish();
    });
    const offEditor = useEditorStore.subscribe((state, previous) => {
      if (state.path !== previous.path || state.selection !== previous.selection) publish();
    });
    const offUi = useUiStore.subscribe((state, previous) => {
      if (state.editingTextId !== previous.editingTextId) publish();
    });
    window.document.addEventListener('visibilitychange', onVisibility);
    // Everyone sees where a newcomer is from the start, not from their first move.
    publish();

    return () => {
      offFlow();
      offEditor();
      offUi();
      window.document.removeEventListener('visibilitychange', onVisibility);
      attach(null);
      throttle.cancel();
    };
  }, [live, storeApi, screenToFlowPosition]);
}
