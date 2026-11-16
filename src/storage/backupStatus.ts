/**
 * When the Library was last backed up, apart from the backup itself: the Library's nudge reads this
 * on every render, and keeping it out of `backup.ts` keeps the ZIP writer (and `fflate`) off the
 * first page load until someone actually backs up or restores.
 */

/** The preference that remembers when the last backup was written (an ISO timestamp, 24 chars). */
export const LAST_BACKUP_PREFERENCE = 'last-backup-at';

/** Whether the last backup is missing or older than `days` — what the Library's nudge asks. */
export function backupIsStale(lastBackupAt: string | null, now = Date.now(), days = 7): boolean {
  if (!lastBackupAt) return true;
  const at = Date.parse(lastBackupAt);
  if (Number.isNaN(at)) return true;
  return now - at > days * 24 * 60 * 60 * 1000;
}

/**
 * Whether the Library holds enough to ask about a backup: a few diagrams, or one that has outlived
 * the day it was made. A just-opened example is neither, and nudging there teaches people to ignore it.
 */
export function worthBackingUp(entries: readonly { createdAt: number }[], now = Date.now()): boolean {
  return entries.length >= 3 || entries.some((entry) => now - entry.createdAt > 24 * 60 * 60 * 1000);
}
