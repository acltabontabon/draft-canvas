import type { DepthPath } from '../../../depth/tree';
import { useFollowPresenter } from './useFollowPresenter';
import { usePresencePublisher } from './usePresencePublisher';
import { usePresenterBroadcast } from './usePresenterBroadcast';

/**
 * Everything the canvas sends and follows in a live session: this person's presence, the owner's
 * presentation for followers, and a follower's camera. Each part is idle outside a session (or
 * outside its role) and none of them re-renders the canvas on a pointer move or camera update.
 *
 * Call it from inside React Flow's provider, after the canvas's own room-camera effect: `path` is the
 * room on screen, and a follower's camera for a new room must be set after that effect's.
 */
export function useLivePresence(path: DepthPath): void {
  usePresencePublisher();
  usePresenterBroadcast();
  useFollowPresenter(path);
}
