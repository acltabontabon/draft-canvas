/**
 * A collaborator's copy of the owner's file: what the owner has confirmed, plus what this person
 * has done that the owner hasn't confirmed yet.
 *
 * Edits show the moment they are made — waiting a round trip before a dragged shape lands would make
 * the canvas feel broken — so a collaborator works on `local`: the confirmed file with their own
 * pending changes applied on top. When the owner's next commit arrives it is applied to `confirmed`
 * (which then equals the owner's file again), the pending changes it acknowledges are dropped, and
 * the rest are applied again on top. A change the owner refused, or that a concurrent edit made moot,
 * simply disappears from `local` at that point, which is the only correct thing it can do.
 *
 * `confirmed` only ever changes by applying the owner's commits in sequence, so it stays exactly the
 * owner's file; that is the invariant everything else rests on, and a gap in the sequence is
 * reported rather than papered over.
 */
import type { DraftDocument } from '../document/types';
import { applyChanges } from './apply';
import type { Change } from './changes';
import { diffFile } from './diff';
import { repairReferences } from './repair';
import { withinLimits } from './limits';

export interface PendingPatch {
  clientSeq: number;
  changes: Change[];
}

export type CommitOutcome = 'applied' | 'duplicate' | 'gap' | 'invalid';

/** A collaborator's patch as the owner applies it — and so as the collaborator must, to agree. */
export function applyPatch(file: DraftDocument, changes: readonly Change[]): DraftDocument {
  return repairReferences(applyChanges(file, changes));
}

export class Replica {
  private confirmedFile: DraftDocument;
  private confirmedSeq: number;
  private queue: PendingPatch[] = [];
  private lastClientSeq = 0;
  private localFile: DraftDocument | undefined;

  constructor(snapshot: DraftDocument, seq: number) {
    this.confirmedFile = snapshot;
    this.confirmedSeq = seq;
  }

  get seq(): number {
    return this.confirmedSeq;
  }

  get confirmed(): DraftDocument {
    return this.confirmedFile;
  }

  get pending(): readonly PendingPatch[] {
    return this.queue;
  }

  /** The file as this person sees it: confirmed, with their unacknowledged changes on top. */
  get local(): DraftDocument {
    // One patch at a time, each repaired, exactly as the owner will apply them: a patch was diffed
    // against the repaired result of the ones before it, and only applies cleanly on top of that.
    this.localFile ??= this.queue.reduce((file, patch) => applyPatch(file, patch.changes), this.confirmedFile);
    return this.localFile;
  }

  /** Records this person's edit; the returned patch is what to send. */
  propose(changes: Change[]): PendingPatch | null {
    if (changes.length === 0) return null;
    const local = this.local;
    this.lastClientSeq += 1;
    const patch = { clientSeq: this.lastClientSeq, changes };
    this.queue.push(patch);
    this.localFile = applyPatch(local, changes);
    return patch;
  }

  /**
   * One of the owner's commits. `changes` must already have been checked (`sanitizeChanges`);
   * `clientSeq` is set when the commit is the owner's answer to this person's own patch.
   */
  receiveCommit(seq: number, changes: Change[], ownClientSeq?: number): CommitOutcome {
    if (seq <= this.confirmedSeq) return 'duplicate';
    if (seq !== this.confirmedSeq + 1) return 'gap';
    const next = applyChanges(this.confirmedFile, changes);
    // Held to the same rules as a file from disk: consistent, and within the document's limits.
    if (repairReferences(next) !== next || !withinLimits(next)) return 'invalid';
    this.confirmedFile = next;
    this.confirmedSeq = seq;
    if (ownClientSeq !== undefined) this.acknowledge(ownClientSeq);
    this.localFile = undefined;
    return 'applied';
  }

  /** The owner's answer to a patch that changed nothing, or that it refused. */
  acknowledge(clientSeq: number): void {
    const before = this.queue.length;
    this.queue = this.queue.filter((patch) => patch.clientSeq > clientSeq);
    if (this.queue.length !== before) this.localFile = undefined;
  }

  /**
   * Starts again from a fresh copy of the owner's file — after a gap, or on reconnecting. Pending
   * changes are kept: they are sent again, and the owner skips any it already applied.
   */
  reset(snapshot: DraftDocument, seq: number): void {
    this.confirmedFile = snapshot;
    this.confirmedSeq = seq;
    this.localFile = undefined;
  }

  /**
   * After a fresh copy that says which of this person's patches the owner has handled: those are
   * dropped, numbering carries on above the owner's count (a fresh page given back an old place
   * starts from it), and whatever is still unconfirmed becomes one patch — the difference between
   * the copy and what is on screen — numbered as the newest. `null` when nothing is left to send.
   */
  rebase(handled: number): PendingPatch | null {
    this.acknowledge(handled);
    const local = this.local;
    this.lastClientSeq = Math.max(this.lastClientSeq, handled);
    if (this.queue.length === 0) return null;
    const changes = diffFile(this.confirmedFile, local);
    this.queue = changes.length === 0 ? [] : [{ clientSeq: this.lastClientSeq, changes }];
    this.localFile = this.queue.length === 0 ? this.confirmedFile : local;
    return this.queue[0] ?? null;
  }

  /** Unconfirmed edits given up (too large to send): `local` is the confirmed file again. */
  discardPending(): void {
    this.queue = [];
    this.localFile = undefined;
  }
}
