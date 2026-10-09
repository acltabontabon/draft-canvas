import type { DraftDocument } from '../document/types';
import { logDiagnostic } from '../lib/diagnostics';
import { clamp } from '../lib/math';
import {
  DocumentConflictError,
  QuotaExceededError,
  reconcileMetadata,
  sharedMetadataOf,
  type DraftRepository,
  type SharedMetadata,
} from './DraftRepository';

export type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

export interface SaveState {
  status: SaveStatus;
  message?: string;
  lastSavedAt?: number;
  /** Saving is paused until the user picks a copy — see `Autosave.resolveConflict`. */
  conflict?: DocumentConflictError['kind'];
}

export interface AutosaveOptions {
  repository: DraftRepository;
  onStateChange: (state: SaveState) => void;
  /** Quiet period after the last edit before writing. */
  debounceMs?: number;
  /** Upper bound on how long continuous editing can defer a write. */
  maxWaitMs?: number;
  /** A save kept a rename or move made elsewhere; the open document should take it on too. */
  onMetadataAdopted?: (documentId: string, metadata: SharedMetadata) => void;
  /** A save found the stored copy deleted or changed elsewhere; saving waits for `resolveConflict`. */
  onConflict?: (documentId: string, kind: DocumentConflictError['kind']) => void;
}

const DEBOUNCE_MS = 700;
const MAX_WAIT_MS = 4000;
/** Below this, a write is too quick to be worth showing — it would only flicker. */
const SHOW_SAVING_AFTER_MS = 300;
/** Long enough for "Saved locally" to actually be read. */
const HOLD_SAVED_MS = 1400;

/**
 * Debounced, non-blocking local autosave.
 *
 * The user never presses save. Writes are coalesced, run off the interaction
 * path, and are flushed when the page is hidden or closed, so a diagram is not
 * lost to a closed tab. A write is never allowed to overlap another: a change
 * arriving mid-write is recorded and written once the current one lands.
 */
/** Every controller alive in this tab, so leaving the page on purpose (reloading for an update) can
 *  finish what's queued first — `pagehide` alone doesn't wait for IndexedDB. */
const live = new Set<Autosave>();

/** Writes everything queued in this tab. Resolves once it's on disk — `false` when anything could
 *  not be written (a pending conflict, a full disk, a closed connection), so a caller about to
 *  reload knows it would be throwing that work away. */
export async function flushAllAutosaves(): Promise<boolean> {
  const results = await Promise.all([...live].map((controller) => controller.flush().catch(() => false)));
  return results.every(Boolean);
}

export class Autosave {
  private readonly repository: DraftRepository;
  private readonly onStateChange: (state: SaveState) => void;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly onMetadataAdopted: AutosaveOptions['onMetadataAdopted'];
  private readonly onConflict: AutosaveOptions['onConflict'];
  /** Per document, the title/project last loaded or written — see `DraftRepository.save`. */
  private readonly baselines = new Map<string, SharedMetadata>();
  /** Per document, the exact object last tracked as what's on disk — see `schedule`. */
  private readonly loaded = new Map<string, DraftDocument>();

  private pending: DraftDocument | null = null;
  /** Whether every version queued since the last write moved only the camera — see `SaveOptions.cameraOnly`. */
  private pendingCameraOnly = false;
  private inFlight = false;
  /** The version whose write is in flight, if any — see `schedule`. */
  private writing: DraftDocument | null = null;
  private current: Promise<void> | null = null;
  private lastFailed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private savingIndicator: ReturnType<typeof setTimeout> | null = null;
  private savedHold: ReturnType<typeof setTimeout> | null = null;
  private firstDirtyAt = 0;
  private disposed = false;
  /** Set while the stored copy was deleted or changed elsewhere: nothing is written until resolved. */
  private conflict: DocumentConflictError['kind'] | null = null;
  /** The next write replaces whatever is stored — the user chose this editor's copy. */
  private overwriteNext = false;
  private state: SaveState = { status: 'idle' };

  constructor(options: AutosaveOptions) {
    this.repository = options.repository;
    this.onStateChange = options.onStateChange;
    this.debounceMs = options.debounceMs ?? DEBOUNCE_MS;
    this.maxWaitMs = options.maxWaitMs ?? MAX_WAIT_MS;
    this.onMetadataAdopted = options.onMetadataAdopted;
    this.onConflict = options.onConflict;
    live.add(this);
  }

  /** Records the metadata of a document as it is on disk right now (just opened or created). */
  track(document: DraftDocument): void {
    this.baselines.set(document.metadata.id, sharedMetadataOf(document.metadata));
    this.loaded.set(document.metadata.id, document);
  }

  /** Drops a document's baseline once it's no longer open, so a long session spent opening many
   *  documents doesn't accumulate one entry per document forever. */
  untrack(documentId: string): void {
    this.baselines.delete(documentId);
    this.loaded.delete(documentId);
  }

  /**
   * The version a closing page still owes the store: what is queued, or, with nothing queued, the
   * write in flight — which the unload is about to abort. Nothing while a conflict stands (the user
   * hasn't chosen this copy), and nothing for a camera move alone. See `reloadStash.ts`.
   */
  unsavedForStash(): DraftDocument | null {
    if (this.conflict) return null;
    if (this.pending) return this.pendingCameraOnly ? null : this.pending;
    return this.inFlight ? this.writing : null;
  }

  /**
   * Records a new version of the document and schedules a write. `cameraOnly` says the only thing
   * that changed since the last version is where the camera is; a single real edit anywhere in what
   * is queued makes the whole write a content write.
   */
  schedule(document: DraftDocument, options?: { cameraOnly?: boolean }): void {
    if (this.disposed) return;
    const id = document.metadata.id;
    // The very object just tracked from disk — a canvas re-opened in place (taking another tab's copy
    // after a conflict, or restoring the stored copy) — is already stored. Writing it again would
    // only mint a new content stamp, and the other tab's next save would then report a conflict
    // nobody caused. Anything queued for it is superseded: the editor now shows what's stored.
    // Not while a write of some *other* version of it is in flight, though: that write is about to
    // replace what's stored, so an undo that hands back the tracked object mid-write has to be written
    // after it — skipping it left the undone edit on disk to come back on the next open.
    const writingOther = this.writing !== null && this.writing.metadata.id === id && this.writing !== document;
    if (this.loaded.get(id) === document && !writingOther) {
      if (this.pending?.metadata.id === id) {
        this.pending = null;
        this.pendingCameraOnly = false;
        // The edit that marked the status dirty is gone, and with it the write its timer was
        // armed for — without this the status would stay "dirty" until some later real save.
        if (this.timer) {
          clearTimeout(this.timer);
          this.timer = null;
        }
        this.firstDirtyAt = 0;
        // A failed write of the version just abandoned no longer matters: the screen is back to what's
        // stored. Left set, closing the canvas would refuse with "could not be saved" over nothing.
        if (!this.conflict) {
          this.lastFailed = false;
          if (this.state.status === 'dirty' || this.state.status === 'error') {
            this.emit({ status: 'idle', message: undefined });
          }
        }
      }
      return;
    }
    this.pendingCameraOnly = options?.cameraOnly === true && (this.pending === null || this.pendingCameraOnly);
    this.pending = document;
    // Kept, not written: the conflict (and its message) stays up until the user resolves it.
    if (this.conflict) return;
    if (this.firstDirtyAt === 0) this.firstDirtyAt = Date.now();
    this.emit({ status: 'dirty' });

    const waited = Date.now() - this.firstDirtyAt;
    const delay = clamp(this.maxWaitMs - waited, 0, this.debounceMs);

    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), delay);
  }

  /**
   * Writes immediately. Used on page hide and before switching documents.
   * Resolves once the newest scheduled version is on disk — waiting out a write
   * already in flight rather than returning early and leaving the latest edits
   * queued behind it. Resolves `false` when that version could not be written.
   */
  async flush(): Promise<boolean> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Never run two writes at once: wait for the current one, then write whatever
    // arrived meanwhile.
    while (this.current) await this.current;
    if (this.disposed) return this.pending === null;
    if (this.conflict) return false;
    if (!this.pending) return !this.lastFailed;
    this.current = this.write();
    try {
      await this.current;
    } finally {
      this.current = null;
    }
    return !this.lastFailed;
  }

  private async write(): Promise<void> {
    const document = this.pending!;
    const cameraOnly = this.pendingCameraOnly;
    this.pending = null;
    this.pendingCameraOnly = false;
    this.inFlight = true;
    this.writing = document;
    this.firstDirtyAt = 0;

    this.savingIndicator = setTimeout(() => {
      if (this.inFlight) this.emit({ status: 'saving' });
    }, SHOW_SAVING_AFTER_MS);

    const id = document.metadata.id;
    const trackedAtStart = this.loaded.get(id);
    try {
      const base = this.baselines.get(id);
      const adopted = await this.repository.save(
        document,
        base,
        this.overwriteNext ? { overwrite: true } : cameraOnly ? { cameraOnly: true } : undefined,
      );
      this.overwriteNext = false;
      this.baselines.set(id, adopted ?? sharedMetadataOf(document.metadata));
      if (adopted && base) {
        // An edit queued during this write still carries the old values, and would read as this
        // editor changing them back.
        // (Re-read through a cast: TypeScript still narrows `pending` to the `null` set above.)
        const queued = this.pending as DraftDocument | null;
        if (queued?.metadata.id === id) this.pending = reconcileMetadata(queued, base, adopted);
        this.onMetadataAdopted?.(id, adopted);
      }
      // What was tracked from disk isn't on disk any more — so an edit that restores that very object
      // (abandoning a just-placed Text node hands back the history entry's `before`) must be written.
      // Left alone if the canvas was re-opened in place while this write ran: that copy is the new baseline.
      if (this.loaded.get(id) === trackedAtStart) this.loaded.delete(id);
      this.lastFailed = false;
      this.clearSavingIndicator();
      this.emit({ status: 'saved', lastSavedAt: Date.now(), message: undefined, conflict: undefined });
      if (this.savedHold) clearTimeout(this.savedHold);
      this.savedHold = setTimeout(() => {
        if (this.state.status === 'saved') this.emit({ status: 'idle', lastSavedAt: Date.now() });
      }, HOLD_SAVED_MS);
    } catch (error) {
      this.lastFailed = true;
      // Keep the unwritten version queued (unless a newer one already replaced it) so
      // the next edit or an explicit flush retries it — not retried on a timer here,
      // since a full disk would only fail again in a tight loop.
      if (this.pending === null) {
        this.pending = document;
        this.pendingCameraOnly = cameraOnly;
      } else {
        // The newer version queued behind this write inherits what this one carried: a pan made while
        // a content write was failing was queued as camera-only, and written that way the content
        // edit would ride a save that keeps the old content stamp — or is dropped outright.
        this.pendingCameraOnly &&= cameraOnly;
      }
      this.clearSavingIndicator();
      if (error instanceof DocumentConflictError) {
        this.conflict = error.kind;
        this.emit({ status: 'error', message: error.message, conflict: error.kind });
        this.onConflict?.(document.metadata.id, error.kind);
        return;
      }
      // The in-memory document is untouched, so the user can still export it.
      this.emit({
        status: 'error',
        message:
          error instanceof QuotaExceededError
            ? error.message
            : 'Could not save to this browser. Export your diagram to keep a copy.',
      });
      logDiagnostic(error, { operation: 'autosave' });
    } finally {
      this.inFlight = false;
      this.writing = null;
      if (this.pending && !this.lastFailed && !this.disposed) {
        this.timer = setTimeout(() => void this.flush(), 0);
      }
    }
  }

  /**
   * Ends a conflict. `keep` writes this editor's copy over whatever is stored now (bringing a deleted
   * canvas back); `discard` drops the unsaved version, for a caller about to reload or close it.
   */
  async resolveConflict(choice: 'keep' | 'discard', document?: DraftDocument): Promise<boolean> {
    if (!this.conflict) return true;
    this.conflict = null;
    this.lastFailed = false;
    if (choice === 'discard') {
      this.pending = null;
      this.emit({ status: 'idle', message: undefined, conflict: undefined });
      return true;
    }
    this.pending ??= document ?? null;
    this.overwriteNext = true;
    return this.flush();
  }

  dispose(): void {
    live.delete(this);
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.clearSavingIndicator();
    if (this.savedHold) clearTimeout(this.savedHold);
  }

  get hasPendingWork(): boolean {
    return this.pending !== null || this.inFlight;
  }

  private clearSavingIndicator(): void {
    if (this.savingIndicator) {
      clearTimeout(this.savingIndicator);
      this.savingIndicator = null;
    }
  }

  private emit(state: SaveState): void {
    this.state = { ...this.state, ...state };
    this.onStateChange(this.state);
  }
}
