/**
 * Which history records a working copy (ADR-2).
 *
 * A document's `metadata.id` travels with the file: a Finder duplicate, a copy on another machine
 * and the original all carry the same one. So history is bound to a *working copy* — the browser's
 * library entry, a desktop file, a Quick Draft — and `metadata.id` is only ever a hint that two
 * copies share a past. Nothing here forks or joins histories on its own: when a copy could continue
 * an existing history, the person is asked, and capture waits for the answer.
 */
import type { Binding, Oid } from './contracts';

/** A working copy as the shell knows it. */
export type CopyKey =
  /** A browser library entry. The library keeps ids unique (`cloneDocumentAsNew` on a collision). */
  | { kind: 'library'; documentId: string }
  /** A Quick Draft or unsaved desktop document, by its recovery id. */
  | { kind: 'draft'; recoveryId: string }
  /** A saved desktop file, by its canonical path. */
  | { kind: 'file'; path: string };

export function copyIdOf(key: CopyKey): string {
  switch (key.kind) {
    case 'library':
      return `lib_${key.documentId}`;
    case 'draft':
      return `draft_${key.recoveryId}`;
    case 'file':
      return `file_${key.path}`;
  }
}

/** A history this device already has, as identity resolution sees it. */
export interface KnownHistory {
  repoId: string;
  documentId: string;
  title: string;
  /** Working copies bound to it, with the history content they last held. */
  copies: { copyId: string; lastWorking: Oid | null; stillExists: boolean }[];
  /** Blob ids of every revision's content on its branches, newest first, bounded. */
  recentContent: Oid[];
}

export type IdentityDecision =
  /** Bound already: carry on. */
  | { kind: 'bound'; binding: Binding }
  /** Nothing on this device shares its past: start a new history when the first capture happens. */
  | { kind: 'new' }
  /**
   * Another copy's history matches this file's id. Continue it only if the person says so: a file
   * moved by hand (`moved`) is offered as "same diagram"; a duplicate (`copy`) as "a copy of".
   */
  | { kind: 'ask'; candidate: KnownHistory; relation: 'moved' | 'copy' };

export function decideIdentity(input: {
  copyId: string;
  documentId: string;
  working: Oid;
  binding: Binding | undefined;
  histories: KnownHistory[];
}): IdentityDecision {
  if (input.binding) return { kind: 'bound', binding: input.binding };
  const candidates = input.histories.filter((history) => history.documentId === input.documentId);
  if (candidates.length === 0) return { kind: 'new' };
  // Prefer the history whose recorded content this copy matches; otherwise the first by id, so the
  // answer never depends on the order histories were listed in.
  const ranked = [...candidates].sort((a, b) => {
    const am = a.recentContent.includes(input.working) ? 0 : 1;
    const bm = b.recentContent.includes(input.working) ? 0 : 1;
    return am - bm || (a.repoId < b.repoId ? -1 : 1);
  });
  const candidate = ranked[0]!;
  // A copy whose original is gone from where it was, holding what that original last held, is the
  // same diagram moved by hand. Anything else sharing the id is a copy.
  const moved = candidate.copies.length > 0 && candidate.copies.every((copy) => !copy.stillExists) && candidate.copies.some((copy) => copy.lastWorking === input.working);
  return { kind: 'ask', candidate, relation: moved ? 'moved' : 'copy' };
}
