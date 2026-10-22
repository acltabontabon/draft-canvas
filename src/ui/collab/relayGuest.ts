import { knock } from '../../collab/lobby';
import type { SessionLink } from '../../collab/rendezvous';
import { guestSession, leaveSession, reconnectSession } from '../../store/collabBridge';
import { useCollabStore } from '../../store/collabStore';
import { useUiStore } from '../../store/uiStore';

/** How long a dropped collaborator keeps knocking before giving up. */
const GIVE_UP_MS = 120_000;
const RETRY_MS = [1_000, 2_000, 4_000, 8_000, 15_000];

/**
 * Brings a collaborator who joined by session link back after their connection drops: they knock
 * again as "returning", the owner's waiting room recognises the place they had and lets them straight
 * back in, and the session takes their unsent edits as if nothing happened. Nobody copies anything,
 * and the owner isn't asked twice.
 */
export function rejoinByRelay(link: SessionLink, relayUrl: string, name: string, stunServer: string): () => void {
  let running = false;
  return () => {
    if (running) return;
    running = true;
    const started = Date.now();
    let attempt = 0;
    const tryOnce = async (): Promise<void> => {
      const session = guestSession();
      if (!session || session.isEnded || useCollabStore.getState().status !== 'reconnecting') {
        running = false;
        return;
      }
      try {
        const returning = session.id && session.resumeKey ? { returning: { peer: session.id, key: session.resumeKey } } : {};
        const pending = await knock(link, relayUrl, { name, ...returning }, stunServer, () => {});
        const transport = await pending.transport;
        if (transport) {
          running = false;
          return reconnectSession(transport);
        }
      } catch {
        // Treated like an unreachable relay: wait and knock again.
      }
      if (Date.now() - started > GIVE_UP_MS) {
        running = false;
        leaveSession();
        useUiStore.getState().notify('Couldn’t get back into the session. Open the session link again to rejoin.', 'error');
        return;
      }
      setTimeout(() => void tryOnce(), RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)]);
    };
    void tryOnce();
  };
}
