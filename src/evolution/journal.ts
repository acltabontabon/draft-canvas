/**
 * One recoverable protocol for operations that span history and the working copy (ADR-3).
 *
 * A Git ref update is atomic; "the branch moved *and* the editor shows its revision *and* autosave
 * holds it" is not, and no backend transaction can make it so. Every such operation — switching
 * alternatives, restoring, finishing a merge, adopting a remote fast-forward, accepting an external
 * change — is therefore written as the same few durable steps, each recorded in the repository's
 * journal before the next begins:
 *
 *   prepared            target revision written (objects only), preconditions checked
 *   pointer-moved       the ref (or the copy's binding) now names the target, by compare-and-swap
 *   working-reconciled  the working copy holds the target, and autosave has it
 *   (entry removed)     done
 *
 * After a crash, `recoveryFor` decides from what is actually stored — never from what the journal
 * hoped — and it never discards work: when the working copy changed in a way it cannot explain, both
 * versions are kept and the person chooses.
 */
import type { JournalRecord, Oid, RefName } from './contracts';

export type OperationKind = 'switch' | 'restore' | 'merge' | 'fast-forward' | 'external' | 'import';
export type Step = 'prepared' | 'pointer-moved' | 'working-reconciled';

/** What an operation moves: a branch, or which alternative a working copy is on. */
export type Pointer =
  | { kind: 'ref'; ref: RefName; from: Oid | null; to: Oid }
  | { kind: 'binding'; copyId: string; fromAlt: string | null; toAlt: string | null };

export interface OperationData extends Record<string, unknown> {
  repoId: string;
  copyId: string;
  sessionId: string;
  pointer: Pointer;
  /** Blob id of the working copy's history content when the operation began. */
  workingBefore: Oid;
  /** Blob id of the history content the working copy should hold when it is done. */
  workingAfter: Oid;
  /** The revision whose snapshot the working copy takes on. */
  target: Oid;
}

export interface Operation extends JournalRecord {
  kind: OperationKind;
  step: Step;
  data: OperationData;
}

export function operationRecord(opId: string, kind: OperationKind, step: Step, data: OperationData, at: number): Operation {
  return { opId, kind, step, at, data };
}

export function isOperation(record: JournalRecord): record is Operation {
  const data = record.data as Partial<OperationData> | undefined;
  return (
    ['switch', 'restore', 'merge', 'fast-forward', 'external', 'import'].includes(record.kind) &&
    ['prepared', 'pointer-moved', 'working-reconciled'].includes(record.step) &&
    typeof data?.repoId === 'string' &&
    typeof data.copyId === 'string' &&
    typeof data.workingBefore === 'string' &&
    typeof data.workingAfter === 'string' &&
    typeof data.target === 'string' &&
    typeof data.pointer === 'object' &&
    data.pointer !== null
  );
}

/** What recovery found stored for the operation's pointer and working copy. */
export interface StoredState {
  /** The ref's value now, or the copy's alternative now, matching `pointer.kind`. */
  pointerAt: { kind: 'ref'; oid: Oid | null } | { kind: 'binding'; altId: string | null };
  /** Blob id of the working copy's history content as autosave holds it now; `null` if it is gone. */
  working: Oid | null;
}

export type Recovery =
  /** Nothing durable happened that needs undoing: drop the entry. */
  | { action: 'discard'; reason: string }
  /** The pointer moved and the working copy is still exactly as it was: finish by loading the target. */
  | { action: 'complete' }
  /** Everything is in place: drop the entry. */
  | { action: 'finish' }
  /** The working copy changed since: keep both, and ask (Resume / Keep current). Nothing is lost either way. */
  | { action: 'ask'; reason: string };

function pointerMoved(pointer: Pointer, at: StoredState['pointerAt']): 'from' | 'to' | 'elsewhere' {
  if (pointer.kind === 'ref' && at.kind === 'ref') {
    if (at.oid === pointer.to) return 'to';
    if (at.oid === pointer.from) return 'from';
    return 'elsewhere';
  }
  if (pointer.kind === 'binding' && at.kind === 'binding') {
    if (at.altId === pointer.toAlt) return 'to';
    if (at.altId === pointer.fromAlt) return 'from';
    return 'elsewhere';
  }
  return 'elsewhere';
}

/**
 * The recovery for one interrupted operation. Pure: the caller reads `stored` and carries out the
 * decision, then deletes the entry (`discard`, `finish`), or completes the step first (`complete`),
 * or leaves it for the person (`ask`).
 */
export function recoveryFor(op: Operation, stored: StoredState): Recovery {
  const moved = pointerMoved(op.data.pointer, stored.pointerAt);
  if (op.step === 'working-reconciled') return { action: 'finish' };
  if (moved === 'from') {
    // The pointer never moved: the prepared objects are unreachable and harmless.
    return { action: 'discard', reason: 'The operation stopped before it changed anything.' };
  }
  if (moved === 'elsewhere') {
    // Someone else (another window, an external Git) moved it on: this operation is stale.
    return { action: 'discard', reason: 'History moved on elsewhere before this finished.' };
  }
  if (stored.working === op.data.workingAfter) return { action: 'finish' };
  if (stored.working === op.data.workingBefore) return { action: 'complete' };
  return { action: 'ask', reason: 'The diagram was changed after this started; both versions are kept.' };
}
