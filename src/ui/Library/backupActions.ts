import { downloadBlob } from '../../export/download';
import { writePreference } from '../../lib/preferences';
import type { RestoreResult } from '../../storage/backup';
import { LAST_BACKUP_PREFERENCE } from '../../storage/backupStatus';
import type { DraftRepository } from '../../storage';

type Notify = (message: string, tone?: 'info' | 'error') => void;
export const BACKUP_COMPLETED_EVENT = 'draft-canvas:backup-completed';

/**
 * The Library's two backup actions, shared by the action row and the storage footnote's nudge so
 * a backup started from either goes the same way and leaves the same timestamp behind.
 *
 * The backup module (and the ZIP library behind it) loads on the click, not with the Library.
 */
export async function backUpLibrary(repository: DraftRepository, notify: Notify): Promise<void> {
  try {
    const { backupFileName, buildBackup } = await import('../../storage/backup');
    const { bytes, count, skipped } = await buildBackup(repository);
    if (count === 0) {
      notify(skipped.length ? 'No diagrams could be read for this backup. Your stored copies have not been changed.' : 'Nothing to back up yet.', skipped.length ? 'error' : 'info');
      return;
    }
    await downloadBlob(new Blob([bytes], { type: 'application/zip' }), backupFileName());
    // Written once the download was handed over, not when it was asked for: a Save dialog that
    // was cancelled (the desktop app rejects with `AbortError`) must not count as a backup.
    if (skipped.length) {
      notify(`Partial backup: saved ${count === 1 ? '1 diagram' : `${count} diagrams`}; ${skipped.length} couldn’t be read. Keep your earlier backup.`, 'error');
      return;
    }
    writePreference(LAST_BACKUP_PREFERENCE, new Date().toISOString());
    window.dispatchEvent(new Event(BACKUP_COMPLETED_EVENT));
    notify(`Backed up ${count === 1 ? '1 diagram' : `${count} diagrams`}.`);
  } catch (error) {
    if ((error instanceof Error || error instanceof DOMException) && error.name === 'AbortError') return;
    notify(error instanceof Error ? error.message : 'The backup couldn’t be written.', 'error');
  }
}

/** Said when a file handed to Restore or Import can't be read as an archive at all. */
export const NOT_A_BACKUP = 'That file isn’t a Draft Canvas backup, or it’s damaged. Nothing was restored.';

/** Reads a backup ZIP into the repository; the caller refreshes the Library afterwards. */
export async function restoreLibrary(repository: DraftRepository, file: File, notify: Notify): Promise<RestoreResult | null> {
  try {
    const { describeRestore, restoreBackup } = await import('../../storage/backup');
    let result: RestoreResult;
    try {
      result = await restoreBackup(repository, new Uint8Array(await file.arrayBuffer()));
    } catch {
      // Only reading the archive itself throws (each entry's own trouble is counted, not thrown), and
      // nothing is written before it has been read. What the reader says ("the end-of-central-
      // directory record is missing") was shown as it was: true, and no help to the person holding
      // the file, at the moment something has already gone wrong.
      notify(NOT_A_BACKUP, 'error');
      return null;
    }
    notify(describeRestore(result), result.restored === 0 && result.skipped.length > 0 ? 'error' : 'info');
    return result;
  } catch (error) {
    notify(error instanceof Error ? error.message : NOT_A_BACKUP, 'error');
    return null;
  }
}

/**
 * Whether a file handed to Import is a backup ZIP rather than a diagram: by its name or type, or by
 * the ZIP signature for one renamed on the way. No diagram format Draft Canvas reads is a ZIP.
 */
export async function looksLikeBackup(file: File): Promise<boolean> {
  if (/\.zip$/i.test(file.name) || file.type === 'application/zip' || file.type === 'application/x-zip-compressed') return true;
  try {
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    return head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  } catch {
    return false;
  }
}
