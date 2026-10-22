/**
 * The owner's side of a session, without any transport: the authoritative file, the numbered commits
 * that changed it, and the rules every collaborator's patch is held to.
 *
 * Commits are numbered from the moment the session starts. Each is the diff of the owner's file
 * before and after — whether the change was the owner's own edit or a collaborator's patch — so
 * applying them in order to the snapshot a collaborator joined with reproduces the owner's file
 * exactly. A collaborator's patch is sanitized, applied, repaired, checked against the document's
 * limits and only then committed; whatever happens, the sender hears back, so its pending queue
 * never waits forever on a patch the owner dropped.
 */
import type { DraftDocument } from '../document/types';
import type { Change } from './changes';
import { diffFile, wireSettings } from './diff';
import type { RejectReason, Role } from './protocol';
import { idsUnique, withinLimits } from './limits';
import { applyPatch } from './replica';
import { sanitizeChanges } from './sanitize';

export interface Commit {
  seq: number;
  changes: Change[];
  /** The peer whose patch this was, or `HOST_ORIGIN` for the owner's own edit. */
  origin: string;
  clientSeq?: number;
}

export const HOST_ORIGIN = 'host';

/** How many recent commits are kept for a collaborator reconnecting after a short drop. */
export const REPLAY_CAPACITY = 512;

export interface PatchOutcome {
  /** Set when the patch changed the file: the commit to send to everyone, the sender included. */
  commit?: Commit;
  /** Set when it did not: the answer to send the sender alone. */
  ack?: { clientSeq: number; rejected?: RejectReason };
}

export interface PeerLedger {
  role: Role;
  /** The newest patch number from this peer already handled — a resent patch is answered, not reapplied. */
  lastClientSeq: number;
}

export class HostCore {
  private current: DraftDocument;
  private seqNo = 0;
  private readonly recent: Commit[] = [];

  constructor(file: DraftDocument) {
    this.current = file;
  }

  get file(): DraftDocument {
    return this.current;
  }

  get seq(): number {
    return this.seqNo;
  }

  /** The file as it is sent to someone joining. */
  snapshot(): DraftDocument {
    const settings = wireSettings(this.current.settings);
    return settings === this.current.settings ? this.current : { ...this.current, settings };
  }

  /**
   * The owner's file changed by the owner's own hand (or anything else on the owner's side: undo,
   * an agent, a reload of the same file). Returns the commit to broadcast, or `null` if nothing
   * shared changed — a camera move, a timestamp.
   */
  commitLocal(next: DraftDocument): Commit | null {
    const changes = diffFile(this.current, next);
    this.current = next;
    if (changes.length === 0) return null;
    return this.record({ seq: this.seqNo + 1, changes, origin: HOST_ORIGIN });
  }

  receivePatch(origin: string, ledger: PeerLedger, clientSeq: number, rawChanges: unknown): PatchOutcome {
    if (clientSeq <= ledger.lastClientSeq) return { ack: { clientSeq } };
    ledger.lastClientSeq = clientSeq;
    if (ledger.role !== 'editor') return { ack: { clientSeq, rejected: 'view-only' } };

    const sanitized = sanitizeChanges(rawChanges);
    if (!sanitized.ok) return { ack: { clientSeq, rejected: 'malformed' } };

    const candidate = applyPatch(this.current, sanitized.changes);
    if (candidate === this.current) return { ack: { clientSeq } };
    if (!withinLimits(candidate)) return { ack: { clientSeq, rejected: 'limits' } };
    // The last line of defence for the invariant everything else rests on: one id, one element.
    if (!idsUnique(candidate)) return { ack: { clientSeq, rejected: 'malformed' } };

    const changes = diffFile(this.current, candidate);
    this.current = candidate;
    if (changes.length === 0) return { ack: { clientSeq } };
    return { commit: this.record({ seq: this.seqNo + 1, changes, origin, clientSeq }) };
  }

  /** The commits after `seq`, or `null` when they are no longer all held (send a snapshot instead). */
  since(seq: number): Commit[] | null {
    if (seq === this.seqNo) return [];
    if (seq > this.seqNo) return null;
    const first = this.recent[0];
    if (!first || first.seq > seq + 1) return null;
    return this.recent.filter((commit) => commit.seq > seq);
  }

  private record(commit: Commit): Commit {
    this.seqNo = commit.seq;
    this.recent.push(commit);
    if (this.recent.length > REPLAY_CAPACITY) this.recent.shift();
    return commit;
  }
}

export { idsUnique, withinLimits };
