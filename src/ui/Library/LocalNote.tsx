import { useEffect, useState } from 'react';
import type { DraftRepository } from '../../storage';
import { backupIsStale, LAST_BACKUP_PREFERENCE } from '../../storage/backup';
import { readPreference } from '../../lib/preferences';
import { isStoragePersisted } from '../../lib/storagePersistence';
import { useUiStore } from '../../store/uiStore';
import { Icon } from '../common/Icon';
import { backUpLibrary } from './backupActions';

/**
 * The local-first promise, sized to how often someone needs to read it: one
 * line always, the honest detail on request. The caveat — clearing site data
 * deletes diagrams — is one click away rather than gone, because a
 * local-first tool that hides that fact will eventually lose someone their
 * work.
 *
 * When the browser refused storage the line turns into the warning and
 * starts open: that is the one time this footnote is the most important
 * thing on the screen.
 */
export function LocalNote({ durable, repository }: { durable: boolean; repository: DraftRepository | null }) {
  const [open, setOpen] = useState(!durable);
  const estimate = useStorageEstimate(repository, open);
  const persisted = usePersisted(durable);
  const notify = useUiStore((state) => state.notify);
  // Re-read after a backup from here, so the nudge goes away the moment it has been answered.
  const [lastBackupAt, setLastBackupAt] = useState(() => readPreference(LAST_BACKUP_PREFERENCE));
  // Only where the warning already applies: storage is real but the browser hasn't promised to keep
  // it, and no backup has been written for a week. With persistence granted there is nothing to nudge.
  const nudge = durable && persisted === false && repository !== null && backupIsStale(lastBackupAt);

  return (
    <div className="dc-local" data-warn={durable ? undefined : 'true'}>
      <button type="button" className="dc-local-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="lock" size={13} />
        <span>
          {durable
            ? 'Stored on this device — nothing you draw leaves it.'
            : 'This browser is blocking local storage — diagrams live in memory only.'}
        </span>
        <span className="dc-local-more">{open ? 'Less' : 'Details'}</span>
      </button>
      {nudge && (
        <p className="dc-local-nudge">
          Back up your diagrams — the browser hasn&rsquo;t promised to keep them.{' '}
          <button
            type="button"
            className="dc-local-more"
            onClick={() =>
              void backUpLibrary(repository, notify).then(() => setLastBackupAt(readPreference(LAST_BACKUP_PREFERENCE)))
            }
          >
            Back up now
          </button>
        </p>
      )}
      {open && (
        <div className="dc-local-detail">
          {durable ? (
            <p>
              Your diagrams are kept in this browser&rsquo;s local database, as plain records. Draft
              Canvas makes no network requests once it has loaded, and over HTTPS it works offline.
            </p>
          ) : (
            <p className="dc-warn">
              Anything you draw is lost when this tab closes. Export it to keep it.
            </p>
          )}
          {persisted === false && (
            <p className="dc-warn">
              This browser hasn&rsquo;t promised to keep them: it may clear them when space runs low, and
              Safari does after a week without a visit. Back up or export what matters.
            </p>
          )}
          <p>
            Clearing this browser&rsquo;s site data deletes them. Export a <code>.draftcanvas</code>{' '}
            file to keep a copy you control.
          </p>
          {estimate && estimate.usage > 0 && <p>About {formatBytes(estimate.usage)} of local storage in use.</p>}
        </div>
      )}
    </div>
  );
}

/** Whether storage is persisted, read once — only asked where storage is durable at all. */
function usePersisted(durable: boolean): boolean | null {
  const [persisted, setPersisted] = useState<boolean | null>(null);
  useEffect(() => {
    if (!durable) return;
    let cancelled = false;
    void isStoragePersisted().then((value) => {
      if (!cancelled) setPersisted(value);
    });
    return () => {
      cancelled = true;
    };
  }, [durable]);
  return persisted;
}

/** One read of `navigator.storage.estimate()`, and only once the detail is open. */
function useStorageEstimate(
  repository: DraftRepository | null,
  enabled: boolean,
): { usage: number; quota: number } | null {
  const [estimate, setEstimate] = useState<{ usage: number; quota: number } | null>(null);
  useEffect(() => {
    if (!enabled || !repository || estimate) return;
    let cancelled = false;
    void repository.usage().then((value) => {
      if (!cancelled && value) setEstimate(value);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, estimate, repository]);
  return estimate;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
