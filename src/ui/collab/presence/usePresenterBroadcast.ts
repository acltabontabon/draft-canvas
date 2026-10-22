import { useEffect } from 'react';
import { useStoreApi } from '@xyflow/react';
import type { FollowState } from '../../../collab/protocol';
import { publishPresenter } from '../../../store/collabBridge';
import { useCollabStore } from '../../../store/collabStore';
import { useEditorStore } from '../../../store/editorStore';
import { encodeFollowViewport } from './follow';
import { sameFollow } from './model';
import { createThrottle } from './throttle';

/** About ten camera updates a second: each follower glides between them (`followMotion`). */
export const PRESENTER_INTERVAL_MS = 100;

/**
 * The owner's side of "follow the presenter": while they present in a live session, what they are
 * showing — their room, their camera, the flow and step — goes to every collaborator, at most ten
 * times a second and only when it changed; the moment they stop, everyone is told so.
 *
 * Read straight from the stores and React Flow's own camera, never written anywhere: like the rest
 * of a presentation, it is not saved, not undone and not exported.
 */
export function usePresenterBroadcast(): void {
  const storeApi = useStoreApi();
  const hosting = useCollabStore((state) => state.role === 'host' && state.status === 'live');

  useEffect(() => {
    if (!hosting) return;
    const throttle = createThrottle<FollowState>(publishPresenter, (a, b) => sameFollow(a, b), PRESENTER_INTERVAL_MS);
    let presenting = false;

    const current = (): FollowState | null => {
      const editor = useEditorStore.getState();
      if (editor.mode !== 'present') return null;
      const { transform, width, height } = storeApi.getState();
      const playback = editor.flowPlayback;
      return {
        path: [...editor.path],
        viewport: encodeFollowViewport({ x: transform[0], y: transform[1], zoom: transform[2] }, { width, height }),
        view: { width, height },
        presenting: true,
        flowId: playback.active ? playback.flowId : null,
        step: playback.active && playback.flowId ? playback.step : null,
      };
    };

    const update = () => {
      const next = current();
      if (next) {
        // An unmeasured canvas has no middle to measure from yet; its first size brings the first update.
        if (storeApi.getState().width === 0) return;
        presenting = true;
        throttle.push(next);
        return;
      }
      if (!presenting) return;
      presenting = false;
      // A stop is never held back behind a camera update still waiting its turn.
      throttle.cancel();
      throttle.reset();
      publishPresenter(null);
    };

    let { transform, width, height } = storeApi.getState();
    const offFlow = storeApi.subscribe((state) => {
      if (state.transform === transform && state.width === width && state.height === height) return;
      ({ transform, width, height } = state);
      if (presenting || useEditorStore.getState().mode === 'present') update();
    });
    const offEditor = useEditorStore.subscribe((state, previous) => {
      if (state.mode !== previous.mode || state.path !== previous.path || state.flowPlayback !== previous.flowPlayback) update();
    });
    update();

    return () => {
      offFlow();
      offEditor();
      throttle.cancel();
      if (presenting) publishPresenter(null);
    };
  }, [hosting, storeApi]);
}
