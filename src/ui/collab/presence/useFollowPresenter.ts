import { useEffect, useRef } from 'react';
import { useReactFlow, useReactFlowStoreApi } from '@xyflow/react';
import type { FollowState } from '../../../collab/protocol';
import { pathKey, type DepthPath } from '../../../depth/tree';
import { motionMs } from '../../../lib/motion';
import { useCollabStore } from '../../../store/collabStore';
import { useEditorStore } from '../../../store/editorStore';
import { useUiStore } from '../../../store/uiStore';
import { decodeFollowViewport, easeOut, followedPlayback, followMotion, roomRoute, type FollowedPlayback, type FollowMotion } from './follow';

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
 * follows, their room and camera go where the presenter's do, and the step the presenter is on is
 * lit on their canvas as it is on the presenter's: the same `flowPlayback` a presentation writes,
 * here while still editing, so the active interaction and its caption are drawn by the same code.
 * It is put away the moment following stops, and Escape — which ends playback — stops following.
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
  const storeApi = useReactFlowStoreApi().viewportStore;
  const guest = useCollabStore((state) => state.role === 'guest');
  const sync = useRef<(arrived: boolean) => void>(() => {});
  /** Set when following itself changes rooms, so the room change that follows isn't taken for the person's own. */
  const walked = useRef(false);

  useEffect(() => {
    if (!guest) return;
    /** Whether the playback on this canvas is the presenter's, put there by `show`. */
    let shown = false;
    /** Set around `show`'s own writes, so they are not taken for the person ending playback. */
    let writing = false;
    /** Lights the presenter's step on this canvas, or (`null`) puts back what following lit. */
    const show = (next: FollowedPlayback | null) => {
      if (!next && !shown) return;
      writing = true;
      shown = next !== null;
      useEditorStore
        .getState()
        .setFlowPlayback(next ? { active: true, walk: undefined, ...next } : { active: false, flowId: null, sequenceNodeId: undefined, walk: undefined, step: 0, stage: undefined });
      // The camera is the presenter's: playback's own guided framing must not reframe on a resize.
      useUiStore.getState().setPresentation({ framing: next ? 'manual' : 'guided' });
      writing = false;
    };

    /** `arrived`: the canvas has just changed rooms and set off for that room's own view. */
    const run = (arrived = false) => {
      const collab = useCollabStore.getState();
      // Nobody is presenting any more: the next presentation starts with an offer, not a camera grab.
      if (!collab.presenter && collab.following) {
        show(null);
        useCollabStore.setState({ following: false });
        return;
      }
      const editor = useEditorStore.getState();
      if (!shouldFollow(collab, editor.mode) || !collab.presenter) {
        show(null);
        return;
      }
      const presenter = collab.presenter;
      if (pathKey(editor.path) !== pathKey(presenter.path)) {
        // A flow belongs to its room, and leaving a room resets playback: let go of it first, so
        // that reset is not read as the person ending it.
        show(null);
        walked.current = true;
        walkTo(presenter.path);
        // A walk that went nowhere (a drag held, a shape not here yet) leaves no room change to
        // claim: still set, it would take the person's own next one for following's and pull them back.
        if (pathKey(useEditorStore.getState().path) === pathKey(editor.path)) walked.current = false;
        return;
      }
      show(followedPlayback(presenter, editor.document));
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
      if (state.mode !== previous.mode) {
        // Their own presentation starts from rest, never from the step they were following.
        if (state.mode === 'present') show(null);
        run();
        return;
      }
      if (writing) return;
      if (shown && state.flowPlayback !== previous.flowPlayback && (!state.flowPlayback.active || state.flowPlayback.flowId === null)) {
        // Playback ended under following: Escape, or the flow deleted (which playback answers with
        // its picker — nothing a follower who is editing should be left in). Escape lets go of the
        // presenter as a pan does; a flow that went is simply no longer lit.
        const ended = !state.flowPlayback.active;
        show(null);
        if (ended) useCollabStore.setState({ following: false });
        return;
      }
      // A flow that reached this copy after the presenter's step did.
      if (!shown && state.document !== previous.document && useCollabStore.getState().following) run();
    });
    run();

    return () => {
      show(null);
      sync.current = () => {};
      offFlow();
      offCollab();
      offEditor();
    };
  }, [guest, storeApi, setViewport, getViewport]);

  useEffect(() => {
    const ours = walked.current;
    walked.current = false;
    const collab = useCollabStore.getState();
    // Stepping into a shape, backing out, finding someone in another room: the person went somewhere
    // themselves, which lets go of the presenter as a drag does — taking them straight back fought them.
    // (Their own presentation only pauses following, so rooms changed there leave it be.)
    if (!ours && shouldFollow(collab, useEditorStore.getState().mode) && collab.role === 'guest' && pathKey(path) !== pathKey(collab.presenter!.path)) {
      useCollabStore.setState({ following: false });
      return;
    }
    sync.current(true);
  }, [path]);
}
