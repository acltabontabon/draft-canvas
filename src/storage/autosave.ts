import type { DraftDocument } from '../document/types';
import { clamp } from '../lib/math';
import { QuotaExceededError, type DraftRepository } from './DraftRepository';

export type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

export interface SaveState {
  status: SaveStatus;
  message?: string;
  lastSavedAt?: number;
}

export interface AutosaveOptions {
  repository: DraftRepository;
  onStateChange: (state: SaveState) => void;
  /** Quiet period after the last edit before writing. */
  debounceMs?: number;
  /** Upper bound on how long continuous editing can defer a write. */
  maxWaitMs?: number;
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
export class Autosave {
  private readonly repository: DraftRepository;
  private readonly onStateChange: (state: SaveState) => void;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;

  private pending: DraftDocument | null = null;
  private inFlight = false;
  private current: Promise<void> | null = null;
  private lastFailed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private savingIndicator: ReturnType<typeof setTimeout> | null = null;
  private savedHold: ReturnType<typeof setTimeout> | null = null;
  private firstDirtyAt = 0;
  private disposed = false;
  private state: SaveState = { status: 'idle' };

  constructor(options: AutosaveOptions) {
    this.repository = options.repository;
    this.onStateChange = options.onStateChange;
    this.debounceMs = options.debounceMs ?? DEBOUNCE_MS;
    this.maxWaitMs = options.maxWaitMs ?? MAX_WAIT_MS;
  }

  /** Records a new version of the document and schedules a write. */
  schedule(document: DraftDocument): void {
    if (this.disposed) return;
    this.pending = document;
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
    this.pending = null;
    this.inFlight = true;
    this.firstDirtyAt = 0;

    this.savingIndicator = setTimeout(() => {
      if (this.inFlight) this.emit({ status: 'saving' });
    }, SHOW_SAVING_AFTER_MS);

    try {
      await this.repository.save(document);
      this.lastFailed = false;
      this.clearSavingIndicator();
      this.emit({ status: 'saved', lastSavedAt: Date.now() });
      if (this.savedHold) clearTimeout(this.savedHold);
      this.savedHold = setTimeout(() => {
        if (this.state.status === 'saved') this.emit({ status: 'idle', lastSavedAt: Date.now() });
      }, HOLD_SAVED_MS);
    } catch (error) {
      this.lastFailed = true;
      // Keep the unwritten version queued (unless a newer one already replaced it) so
      // the next edit or an explicit flush retries it — not retried on a timer here,
      // since a full disk would only fail again in a tight loop.
      this.pending ??= document;
      this.clearSavingIndicator();
      // The in-memory document is untouched, so the user can still export it.
      this.emit({
        status: 'error',
        message:
          error instanceof QuotaExceededError
            ? error.message
            : 'Could not save to this browser. Export your diagram to keep a copy.',
      });
      console.error('[draft-canvas] Autosave failed.', error);
    } finally {
      this.inFlight = false;
      if (this.pending && !this.lastFailed && !this.disposed) {
        this.timer = setTimeout(() => void this.flush(), 0);
      }
    }
  }

  dispose(): void {
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
