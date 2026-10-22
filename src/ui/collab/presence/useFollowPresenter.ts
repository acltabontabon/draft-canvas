import { useEffect, useRef } from 'react';
import { useReactFlow, useStoreApi } from '@xyflow/react';
import type { FollowState } from '../../../collab/protocol';
import { pathKey, type DepthPath } from '../../../depth/tree';
import { motionMs } from '../../../lib/motion';
import { useCollabStore } from '../../../store/collabStore';
import { useEditorStore } from '../../../store/editorStore';
import { decodeFollowViewport, easeOut, followMotion, roomRoute, type FollowMotion } from './follow';

/**
 * Whether this collaborator's camera should track `presenter` right now. Their own presentation
 * owns their camera, so following waits it out rather than fighting it.
 */
export function shouldFollow(state: { presenter: FollowState | null; following: boolean }, mode: string): boolean {
  return state.presenter !== null && state.following && mode !== 'present';
}

/**
 * A collaborator's own hand on the camera — a drag, a wheel, a pinch — lets go of the presenter.
 * Called from `Canvas`'s `onMove`, which React Flow calls with the gesture's event for a person's
 * move and with `null` for the app's own (following included), so following never stops itself.
 */
export function stopFollowingOnGesture(event: Event | null): void {
  if (!event) return;
  const collab = useCollabStore.getState();
  if (collab.role === 'guest' && collab.following) useCollabStore.setState({ following: false });
}

/** The smallest move there is, for a camera that must be stopped where it is. */
const ARRIVAL: FollowMotion = { duration: 1, interpolate: 'linear', easeOut: false };

/** Steps from the room on screen to `to`, through `editorStore`'s own navigation (never a write). */
function walkTo(to: readonly string[]): void {
  const editor = useEditorStore.getState();
  const route = roomRoute(editor.path, to);
  if (route.exitTo !== null) editor.exitTo(route.exitTo);
  for (const id of route.enter) {
    // A room this copy can't enter yet (its shape still on the way) is retried on the next update.
    if (!useEditorStore.getState().enterInside(id)) return;
  }
}

/**
 * A collaborator's side of "follow the presenter": while the owner presents and this person
 * follows, their room and camera go where the presenter's do.
 *
 * Subscribes to the stores directly: the presenter's camera arrives ten times a second and would
 * otherwise re-render the whole canvas each time. Changing rooms is the editor's ordinary navigation
 * — and `Canvas` answers every room change by moving the camera to that room's own view — so the
 * camera for a new room is applied from an effect on `path`, which runs after `Canvas`'s own (this
 * hook is called after it), and wins. `path` must be the canvas's current room.
 *
 * Transient like the rest of a session: `following` lives in `collabStore`, and nothing here is
 * saved, undone or exported.
 */
export function useFollowPresenter(path: DepthPath): void {
  const { setViewport, getViewport } = useReactFlow();
  const storeApi = useStoreApi();
  const guest = useCollabStore((state) => state.role === 'guest');
  const sync = useRef<(arrived: boolean) => void>(() => {});

  useEffect(() => {
    if (!guest) return;
    /** `arrived`: the canvas has just changed rooms and set off for that room's own view. */
    const run = (arrived = false) => {
      const collab = useCollabStore.getState();
      // Nobody is presenting any more: the next presentation starts with an offer, not a camera grab.
      if (!collab.presenter && collab.following) {
        useCollabStore.setState({ following: false });
        return;
      }
      const editor = useEditorStore.getState();
      if (!shouldFollow(collab, editor.mode) || !collab.presenter) return;
      const presenter = collab.presenter;
      if (pathKey(editor.path) !== pathKey(presenter.path)) {
        walkTo(presenter.path);
        return;
      }
      const { width, height } = storeApi.getState();
      if (width === 0 || height === 0) return;
      const view = { width, height };
      const target = decodeFollowViewport(presenter.viewport, view, presenter.view);
      // Just arrived, the camera is still the last room's and already moving to this one's: even a
      // target that happens to match where it stands must be set, to stop that move.
      const motion = followMotion(getViewport(), target, view) ?? (arrived ? ARRIVAL : null);
      if (!motion) return;
      void setViewport(target, {
        // Never 0, even for reduced motion: an instant jump does not interrupt a transition still in
        // flight (the room's own camera move), and that move would carry on over it.
        duration: Math.max(1, motionMs(motion.duration)),
        interpolate: motion.interpolate,
        ...(motion.easeOut ? { ease: easeOut } : {}),
      });
    };
    sync.current = run;

    let { width, height } = storeApi.getState();
    const offFlow = storeApi.subscribe((state) => {
      if (state.width === width && state.height === height) return;
      ({ width, height } = state);
      run();
    });
    const offCollab = useCollabStore.subscribe((state, previous) => {
      if (state.presenter !== previous.presenter || state.following !== previous.following) run();
    });
    // Leaving their own presentation hands the camera back to the presenter they follow.
    const offEditor = useEditorStore.subscribe((state, previous) => {
      if (state.mode !== previous.mode) run();
    });
    run();

    return () => {
      sync.current = () => {};
      offFlow();
      offCollab();
      offEditor();
    };
  }, [guest, storeApi, setViewport, getViewport]);

  useEffect(() => {
    sync.current(true);
  }, [path]);
}
