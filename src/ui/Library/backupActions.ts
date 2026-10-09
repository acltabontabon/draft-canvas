import { downloadBlob } from '../../export/download';
import { writePreference } from '../../lib/preferences';
import { backupFileName, buildBackup, describeRestore, LAST_BACKUP_PREFERENCE, restoreBackup, type RestoreResult } from '../../storage/backup';
import type { DraftRepository } from '../../storage';

type Notify = (message: string, tone?: 'info' | 'error') => void;
export const BACKUP_COMPLETED_EVENT = 'draft-canvas:backup-completed';

/**
 * The Library's two backup actions, shared by the action row and the storage footnote's nudge so
 * a backup started from either goes the same way and leaves the same timestamp behind.
 */
export async function backUpLibrary(repository: DraftRepository, notify: Notify): Promise<void> {
  try {
    const { bytes, count, skipped } = await buildBackup(repository);
    if (count === 0) {
      notify(skipped.length ? 'No diagrams could be read for this backup. Your stored copies have not been changed.' : 'Nothing to back up yet.', skipped.length ? 'error' : 'info');
      return;
    }
    await downloadBlob(new Blob([bytes], { type: 'application/zip' }), backupFileName());
    // Written once the download was handed over, not when it was asked for: a Save dialog that
    // was cancelled (the desktop app rejects with `AbortError`) must not count as a backup.
    if (skipped.length) {
      notify(`Partial backup: saved ${count === 1 ? '1 diagram' : `${count} diagrams`}; ${skipped.length} could not be read. Keep your earlier backup.`, 'error');
      return;
    }
    writePreference(LAST_BACKUP_PREFERENCE, new Date().toISOString());
    window.dispatchEvent(new Event(BACKUP_COMPLETED_EVENT));
    notify(`Backed up ${count === 1 ? '1 diagram' : `${count} diagrams`}.`);
  } catch (error) {
    if ((error instanceof Error || error instanceof DOMException) && error.name === 'AbortError') return;
    notify(error instanceof Error ? error.message : 'The backup could not be written.', 'error');
  }
}

/** Reads a backup ZIP into the repository; the caller refreshes the Library afterwards. */
export async function restoreLibrary(repository: DraftRepository, file: File, notify: Notify): Promise<RestoreResult | null> {
  try {
    const result = await restoreBackup(repository, new Uint8Array(await file.arrayBuffer()));
    notify(describeRestore(result), result.restored === 0 && result.skipped.length > 0 ? 'error' : 'info');
    return result;
  } catch (error) {
    notify(error instanceof Error ? error.message : 'That file is not a Draft Canvas backup.', 'error');
    return null;
  }
}
