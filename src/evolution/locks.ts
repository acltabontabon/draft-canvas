/**
 * Exclusive locks across every tab and worker of this origin, for the few steps that must not
 * interleave: a ref's compare-and-swap, `repo.json`, maintenance.
 *
 * A repository lock serialises writes to the repository. It is not an editing lock: which editor
 * may record history for a working copy is decided by `identity.ts` (ADR-2), never by who happens
 * to hold this for a moment.
 */
import { HistoryError } from './contracts';

export type LockRunner = <T>(name: string, run: () => Promise<T>) => Promise<T>;

interface LockManagerLike {
  request<T>(name: string, options: { mode: 'exclusive' | 'shared'; ifAvailable?: boolean }, run: (lock: unknown) => Promise<T>): Promise<T>;
}

function lockManager(): LockManagerLike | undefined {
  const nav = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator;
  return nav?.locks && typeof nav.locks.request === 'function' ? nav.locks : undefined;
}

/** Whether this browser can serialise history writes across tabs. Without it history is read-only. */
export function hasWebLocks(): boolean {
  return lockManager() !== undefined;
}

/** Web Locks: held until `run` settles, released by the browser if the tab or worker dies. */
export const webLocks: LockRunner = (name, run) => {
  const locks = lockManager();
  if (!locks) {
    return Promise.reject(new HistoryError('unavailable', 'This browser cannot coordinate history between tabs, so history is read-only here.'));
  }
  return locks.request(name, { mode: 'exclusive' }, () => run());
};

/** One process only: tests, and a single-window desktop page. */
export function processLocks(): LockRunner {
  const tails = new Map<string, Promise<unknown>>();
  return (name, run) => {
    const before = tails.get(name) ?? Promise.resolve();
    const result = before.then(run, run);
    const tail = result.catch(() => undefined);
    tails.set(name, tail);
    void tail.then(() => {
      if (tails.get(name) === tail) tails.delete(name);
    });
    return result;
  };
}

export const repoLock = (repoId: string): string => `draft-canvas-history:repo:${repoId}`;
export const copyLock = (copyId: string): string => `draft-canvas-history:copy:${copyId}`;
