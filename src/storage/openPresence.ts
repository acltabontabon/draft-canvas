/**
 * Which canvases are open in some tab of this browser, through the Web Locks API: every tab holds a
 * shared lock named for each canvas it has open, and the lock is gone when the tab closes, crashes
 * or navigates away — nothing to clean up, and nothing stored.
 *
 * Closing a canvas prunes background images only its undo history could still bring back. Another
 * tab with the same canvas open has its own history, which may name one of those images; pruning
 * from under it left that tab's undo pointing at nothing. So the prune asks first.
 */

const PREFIX = 'draft-canvas:open:';

function lockManager(): LockManager | undefined {
  return typeof navigator !== 'undefined' ? navigator.locks : undefined;
}

/**
 * Marks `documentId` open in this tab until the returned function is called. That function resolves
 * once the lock is actually released, so a check made after it never sees this tab's own hold.
 */
export function holdOpen(documentId: string): () => Promise<void> {
  const locks = lockManager();
  if (!locks) return () => Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const done = locks.request(PREFIX + documentId, { mode: 'shared' }, () => held).catch(() => {});
  return () => {
    release();
    return done;
  };
}

/**
 * Whether any tab holds `documentId` open — call it after releasing this tab's own hold. `null`
 * when the browser can't say (no Web Locks), which a caller about to delete something reads as "yes".
 */
export async function openAnywhere(documentId: string): Promise<boolean | null> {
  const locks = lockManager();
  if (!locks) return null;
  try {
    // Exclusive, and only if free: granted means no tab holds it shared. Released at once.
    return await locks.request(PREFIX + documentId, { mode: 'exclusive', ifAvailable: true }, (lock) => lock === null);
  } catch {
    return null;
  }
}
