import type { DraftDocument } from '../document/types';
import { logDiagnostic } from '../lib/diagnostics';
import { clamp } from '../lib/math';
import {
  DocumentConflictError,
  reconcileMetadata,
  sharedMetadataOf,
  type DraftRepository,
  type SharedMetadata,
} from './DraftRepository';
import { saveFailureMessage, saveFailureOf, type SaveFailure } from './saveFailure';

export type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

export interface SaveState {
  status: SaveStatus;
  message?: string;
  /** Why the last write failed, when it did and it was not a conflict — see `saveFailure.ts`. */
  failure?: SaveFailure;
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
  /** Quiet period before a write that only moves the camera (pan, zoom). Default: `CAMERA_PATIENCE` times `debounceMs`. */
  cameraDebounceMs?: number;
  /** Upper bound on how long continuous panning and zooming can defer that write. Default: `CAMERA_PATIENCE / 2` times `maxWaitMs`. */
  cameraMaxWaitMs?: number;
  /** A save kept a rename or move made elsewhere; the open document should take it on too. */
  onMetadataAdopted?: (documentId: string, metadata: SharedMetadata) => void;
  /** A save found the stored copy deleted or changed elsewhere; saving waits for `resolveConflict`. */
  onConflict?: (documentId: string, kind: DocumentConflictError['kind']) => void;
  /** A version of the document is on disk — whatever a reload stash still holds for it is not owed any more. */
  onSaved?: (documentId: string) => void;
}

/** A version waiting to be written, and whether everything queued in it since the last write only moved the camera. */
interface Queued {
  document: DraftDocument;
  cameraOnly: boolean;
}

/** What a closing page still owes the store for one document — see `Autosave.unsavedForStash`. */
export interface Unsaved {
  document: DraftDocument;
  /** It was held back by a conflict with another tab's copy, which the user hasn't resolved. */
  conflict: boolean;
}

const DEBOUNCE_MS = 700;
const MAX_WAIT_MS = 4000;
/**
 * A write of only the camera still rewrites the whole body (about 1 MB at 3000 shapes), and a pan or
 * zoom produces a new camera every frame. It waits five times as long as an edit does for the person
 * to stop (3.5 s), and when they never do still lands every 10 s — rarely enough to be cheap, often
 * enough that a crash loses little more than where they were looking.
 */
const CAMERA_PATIENCE = 5;
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
  private readonly cameraDebounceMs: number;
  private readonly cameraMaxWaitMs: number;
  private readonly onMetadataAdopted: AutosaveOptions['onMetadataAdopted'];
  private readonly onConflict: AutosaveOptions['onConflict'];
  private readonly onSaved: AutosaveOptions['onSaved'];
  /** Per document, the title/project last loaded or written — see `DraftRepository.save`. */
  private readonly baselines = new Map<string, SharedMetadata>();
  /** Per document, the exact object last tracked as what's on disk — see `schedule`. */
  private readonly loaded = new Map<string, DraftDocument>();

  /**
   * Per document, the newest version not yet written, oldest document first. Per document rather than
   * one slot: an edit to the canvas still on screen while another one opens was queued, then replaced
   * by the new canvas's first save (a pan is enough) and never written. See `SaveOptions.cameraOnly`.
   */
  private queue = new Map<string, Queued>();
  private inFlight = false;
  /** The version whose write is in flight, if any — see `schedule`. */
  private writing: DraftDocument | null = null;
  /** Whether that in-flight write moves only the camera — see `unsavedForStash`. */
  private writingCameraOnly = false;
  private current: Promise<void> | null = null;
  private lastFailed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private savingIndicator: ReturnType<typeof setTimeout> | null = null;
  private savedHold: ReturnType<typeof setTimeout> | null = null;
  private firstDirtyAt = 0;
  /** The write waiting on `timer` carries nothing but the camera — see `schedule`. */
  private waitingOnCamera = false;
  private disposed = false;
  /** Set while the stored copy was deleted or changed elsewhere: nothing is written until resolved. */
  private conflict: DocumentConflictError['kind'] | null = null;
  /** The document that conflict is about. */
  private conflictId: string | null = null;
  /** The next write replaces whatever is stored — the user chose this editor's copy. */
  private overwriteNext = false;
  private state: SaveState = { status: 'idle' };

  constructor(options: AutosaveOptions) {
    this.repository = options.repository;
    this.onStateChange = options.onStateChange;
    this.debounceMs = options.debounceMs ?? DEBOUNCE_MS;
    this.maxWaitMs = options.maxWaitMs ?? MAX_WAIT_MS;
    this.cameraDebounceMs = options.cameraDebounceMs ?? this.debounceMs * CAMERA_PATIENCE;
    this.cameraMaxWaitMs = options.cameraMaxWaitMs ?? this.maxWaitMs * (CAMERA_PATIENCE / 2);
    this.onMetadataAdopted = options.onMetadataAdopted;
    this.onConflict = options.onConflict;
    this.onSaved = options.onSaved;
    live.add(this);
  }

  /** Records the metadata of a document as it is on disk right now (just opened or created). */
  track(document: DraftDocument): void {
    this.baselines.set(document.metadata.id, sharedMetadataOf(document.metadata));
    this.loaded.set(document.metadata.id, document);
  }

  /** The title/project last loaded or written for a document — what a reload stash is based on. */
  baselineOf(documentId: string): SharedMetadata | undefined {
    return this.baselines.get(documentId);
  }

  /** Drops a document's baseline once it's no longer open, so a long session spent opening many
   *  documents doesn't accumulate one entry per document forever. */
  untrack(documentId: string): void {
    this.baselines.delete(documentId);
    this.loaded.delete(documentId);
  }

  /**
   * The versions a closing page still owes the store, one per document: what is queued, or, with
   * nothing queued, the write in flight — which the unload is about to abort. Nothing for a camera
   * move alone, and nothing for a canvas deleted elsewhere (there is no row to reopen it from). A copy
   * held back by a changed-elsewhere conflict is owed, marked so the reopen asks again rather than
   * deciding for the user. See `reloadStash.ts`.
   */
  unsavedForStash(): Unsaved[] {
    const owed = new Map<string, Unsaved>();
    // A camera-only write in flight owes nothing either: stashed, the reopen wrote it back as a
    // content save, minting a new content stamp and a cross-tab conflict nobody caused. A content
    // write in flight does — and a camera-only version queued behind it is that content plus a pan.
    if (this.writing && !this.writingCameraOnly) owed.set(this.writing.metadata.id, { document: this.writing, conflict: false });
    for (const [id, queued] of this.queue) {
      const conflict = this.conflictId === id ? this.conflict : null;
      if (conflict === 'deleted' || (queued.cameraOnly && !owed.has(id))) continue;
      owed.set(id, { document: queued.document, conflict: conflict === 'changed' });
    }
    return [...owed.values()];
  }

  /**
   * Holds `document` back as conflicting with what another tab stored, exactly as a save that found the
   * row changed would: kept, unwritten, until the user picks a copy with `resolveConflict`. For edits a
   * reload stash brought back over content saved elsewhere meanwhile.
   */
  holdConflict(document: DraftDocument): void {
    if (this.disposed) return;
    const id = document.metadata.id;
    this.queue.set(id, { document, cameraOnly: false });
    this.raise(id, new DocumentConflictError('changed'));
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
      // Only when nothing else is queued: another canvas's version still owes a write, and its timer.
      if (this.queue.delete(id) && this.queue.size === 0) {
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
            this.emit({ status: 'idle', message: undefined, failure: undefined });
          }
        }
      }
      return;
    }
    const queued = this.queue.get(id);
    this.queue.set(id, { document, cameraOnly: options?.cameraOnly === true && (queued === undefined || queued.cameraOnly) });
    // Kept, not written: the conflict (and its message) stays up until the user resolves it.
    if (this.conflict) return;
    // The last write failed, and the status bar is asking what to do about it: moving the camera is
    // not an answer, and retrying the whole body on every frame of a pan would only fail again.
    if (this.lastFailed && options?.cameraOnly === true) return;
    // Looking around is not unsaved work: the status stays as it was (a failed save keeps asking for
    // its Retry and Export), and the write waits longer — see `CAMERA_PATIENCE`. The first real
    // edit starts the ordinary clock over, so a long pan before it does not make it write at once.
    const cameraOnly = [...this.queue.values()].every((entry) => entry.cameraOnly);
    if (this.firstDirtyAt === 0 || (this.waitingOnCamera && !cameraOnly)) this.firstDirtyAt = Date.now();
    this.waitingOnCamera = cameraOnly;
    if (!cameraOnly) this.emit({ status: 'dirty' });

    const waited = Date.now() - this.firstDirtyAt;
    const delay = cameraOnly
      ? clamp(this.cameraMaxWaitMs - waited, 0, this.cameraDebounceMs)
      : clamp(this.maxWaitMs - waited, 0, this.debounceMs);

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
    for (;;) {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      // Never run two writes at once: wait for the current one, then write whatever
      // arrived meanwhile.
      while (this.current) await this.current;
      if (this.disposed) return this.queue.size === 0;
      if (this.conflict) return false;
      if (this.queue.size === 0) return !this.lastFailed;
      this.current = this.write();
      try {
        await this.current;
      } finally {
        this.current = null;
      }
      // A close or reload trusts this promise to cover everything queued during the write too.
      // Leaving that version to write()'s timer lets the caller dispose us before it reaches disk.
      // A failure keeps its version pending for an explicit retry, never a tight loop here.
      if (this.lastFailed) return false;
    }
  }

  private async write(): Promise<void> {
    const [id, { document, cameraOnly }] = this.queue.entries().next().value!;
    this.queue.delete(id);
    this.inFlight = true;
    this.writing = document;
    this.writingCameraOnly = cameraOnly && !this.overwriteNext;
    this.firstDirtyAt = 0;
    this.waitingOnCamera = false;

    // Not for a camera move: nobody asked for that write, so it has no business flickering the bar.
    if (!this.writingCameraOnly) {
      this.savingIndicator = setTimeout(() => {
        if (this.inFlight) this.emit({ status: 'saving' });
      }, SHOW_SAVING_AFTER_MS);
    }

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
        const queued = this.queue.get(id);
        if (queued) queued.document = reconcileMetadata(queued.document, base, adopted);
        this.onMetadataAdopted?.(id, adopted);
      }
      // What was tracked from disk isn't on disk any more — so an edit that restores that very object
      // (abandoning a just-placed Text node hands back the history entry's `before`) must be written.
      // Left alone if the canvas was re-opened in place while this write ran: that copy is the new baseline.
      if (this.loaded.get(id) === trackedAtStart) this.loaded.delete(id);
      this.lastFailed = false;
      this.onSaved?.(id);
      this.clearSavingIndicator();
      if (this.queue.size > 0) {
        // Edits queued during this write are still unsaved; "Saved" now would be a claim the next
        // write might fail to keep. The status stays dirty until that one lands.
        this.emit({ status: 'dirty', lastSavedAt: Date.now(), message: undefined, failure: undefined, conflict: undefined });
      } else {
        this.emit({ status: 'saved', lastSavedAt: Date.now(), message: undefined, failure: undefined, conflict: undefined });
        if (this.savedHold) clearTimeout(this.savedHold);
        this.savedHold = setTimeout(() => {
          if (this.state.status === 'saved') this.emit({ status: 'idle', lastSavedAt: Date.now() });
        }, HOLD_SAVED_MS);
      }
    } catch (error) {
      this.lastFailed = true;
      // Keep the unwritten version queued, first in line (unless a newer one already replaced it), so
      // the next edit or an explicit flush retries it — not retried on a timer here,
      // since a full disk would only fail again in a tight loop.
      const newer = this.queue.get(id);
      if (!newer) {
        this.queue = new Map([[id, { document, cameraOnly }], ...this.queue]);
      } else {
        // The newer version queued behind this write inherits what this one carried: a pan made while
        // a content write was failing was queued as camera-only, and written that way the content
        // edit would ride a save that keeps the old content stamp — or is dropped outright.
        newer.cameraOnly &&= cameraOnly;
      }
      this.clearSavingIndicator();
      if (error instanceof DocumentConflictError) {
        this.raise(id, error);
        return;
      }
      // The in-memory document is untouched, so the user can still export it.
      const failure = saveFailureOf(error);
      this.emit({ status: 'error', failure, message: saveFailureMessage(failure) });
      logDiagnostic(error, { operation: 'autosave' });
    } finally {
      this.inFlight = false;
      this.writing = null;
      this.writingCameraOnly = false;
      if (this.queue.size > 0 && !this.lastFailed && !this.disposed) {
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
    const id = this.conflictId!;
    this.conflict = null;
    this.conflictId = null;
    this.lastFailed = false;
    if (choice === 'discard') {
      this.queue.delete(id);
      // Anything queued for another canvas meanwhile is still owed.
      if (this.queue.size > 0) return this.flush();
      this.emit({ status: 'idle', message: undefined, failure: undefined, conflict: undefined });
      return true;
    }
    if (!this.queue.has(id) && document?.metadata.id === id) this.queue.set(id, { document, cameraOnly: false });
    // The conflicting copy is written first, and it alone overwrites.
    const conflicting = this.queue.get(id);
    if (conflicting) {
      this.queue.delete(id);
      this.queue = new Map([[id, conflicting], ...this.queue]);
    }
    this.overwriteNext = true;
    return this.flush();
  }

  /**
   * Gives up what was queued for one document — the person chose to leave without saving it (after a
   * failed save, with the copy exported or not wanted). Nothing else is touched: another document's
   * pending write is still owed.
   */
  discardPending(documentId: string): void {
    this.queue.delete(documentId);
    this.lastFailed = false;
    if (this.queue.size === 0) {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      this.firstDirtyAt = 0;
      this.waitingOnCamera = false;
      if (!this.conflict) this.emit({ status: 'idle', message: undefined, failure: undefined });
    } else if (!this.timer && !this.disposed) {
      this.timer = setTimeout(() => void this.flush(), 0);
    }
  }

  dispose(): void {
    live.delete(this);
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.clearSavingIndicator();
    if (this.savedHold) clearTimeout(this.savedHold);
  }

  get hasPendingWork(): boolean {
    return this.queue.size > 0 || this.inFlight;
  }

  private raise(id: string, error: DocumentConflictError): void {
    this.conflict = error.kind;
    this.conflictId = id;
    this.emit({ status: 'error', message: error.message, conflict: error.kind });
    this.onConflict?.(id, error.kind);
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
