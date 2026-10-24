import type { CollabTransport } from '../../collab/connect';
import { knock } from '../../collab/lobby';
import type { SessionLink } from '../../collab/rendezvous';
import { guestSession, leaveSessionKeepingView, reconnectSession } from '../../store/collabBridge';
import { useCollabStore } from '../../store/collabStore';

/** How long a dropped collaborator keeps knocking before giving up. */
const GIVE_UP_MS = 120_000;
const RETRY_MS = [1_000, 2_000, 4_000, 8_000, 15_000];

/**
 * The knock's connection — or `null` once the session is no longer waiting for one (the old link
 * recovered by itself, or the session ended) or the time to give up has come. A knock left waiting on
 * an owner who has gone (a crashed or reloaded tab) would otherwise hang until the relay closes the
 * room, and one outlived by a recovered link would stay at the owner's door. A connection that still
 * arrives after that is closed.
 */
function untilBackOrGivenUp(pending: Awaited<ReturnType<typeof knock>>, deadline: number, wanted: () => boolean): Promise<CollabTransport | null> {
  return new Promise((resolve) => {
    let done = false;
    const settle = (transport: CollabTransport | null) => {
      if (done) return transport?.close('cancelled');
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(transport);
    };
    const stop = () => {
      if (done) return;
      pending.cancel();
      settle(null);
    };
    const timer = setTimeout(stop, Math.max(0, deadline - Date.now()));
    const unsubscribe = useCollabStore.subscribe(() => {
      if (!wanted()) stop();
    });
    // Back already, while the knock was being made: nothing to wait for (left, it sat at the owner's
    // door for two minutes and was let in to a place already filled).
    if (!wanted()) stop();
    pending.transport.then(settle, () => settle(null));
  });
}

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
    const session = guestSession();
    if (!session) return;
    // A retry belongs to the session that dropped. A later session can also be reconnecting when
    // this one's timer or knock finishes; it must never send that session to the old owner.
    const wanted = () => guestSession() === session && !session.isEnded && useCollabStore.getState().status === 'reconnecting';
    running = true;
    const started = Date.now();
    let attempt = 0;
    const tryOnce = async (): Promise<void> => {
      if (!wanted()) {
        running = false;
        return;
      }
      try {
        const returning = session.id && session.resumeKey ? { returning: { peer: session.id, key: session.resumeKey } } : {};
        const pending = await knock(link, relayUrl, { name, ...returning }, stunServer, () => {});
        if (!wanted()) {
          pending.cancel();
          // Cancellation can race a successful connection; close anything already resolved too.
          void pending.transport.then((transport) => transport?.close('cancelled'), () => {});
          running = false;
          return;
        }
        const transport = await untilBackOrGivenUp(pending, started + GIVE_UP_MS, wanted);
        if (transport) {
          running = false;
          if (!wanted()) return transport.close('cancelled');
          return reconnectSession(transport);
        }
      } catch {
        // Treated like an unreachable relay: wait and knock again.
      }
      if (!wanted()) {
        running = false;
        return;
      }
      if (Date.now() - started >= GIVE_UP_MS) {
        running = false;
        leaveSessionKeepingView({ message: 'Couldn’t get back into the session. Open the session link again to rejoin.', tone: 'error' });
        return;
      }
      setTimeout(() => void tryOnce(), RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)]);
    };
    void tryOnce();
  };
}
