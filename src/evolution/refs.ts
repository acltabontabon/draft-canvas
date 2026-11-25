/**
 * The refs Canvas Evolution writes, and the check every ref name passes before any backend sees it.
 *
 * Names are built from stable random ids, never from what a person typed: an alternative called
 * "../../HEAD" or "-x" is a display name and nothing else. Refs read from outside (a bundle, a
 * remote) go through `isSafeRefName`, a strict subset of `git check-ref-format`.
 */
import type { Oid, RefName } from './contracts';

export const MAIN_REF: RefName = 'refs/heads/main';
export const ALT_PREFIX = 'refs/heads/alt/';
export const ARCHIVE_PREFIX = 'refs/heads/archive/alt/';
export const MILESTONE_PREFIX = 'refs/tags/milestone/';
/** Holds a merge session's objects reachable until it finishes, so maintenance never prunes them. */
export const MERGE_PREFIX = 'refs/draft-canvas/merge/';
export const REMOTE_PREFIX = 'refs/remotes/origin/';

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function isSafeId(id: string): boolean {
  return ID.test(id);
}

function requireId(id: string): string {
  if (!isSafeId(id)) throw new Error(`Not a history id: ${JSON.stringify(id.slice(0, 40))}`);
  return id;
}

/** The branch an alternative lives on; `null` is the primary architecture. */
export function branchOf(altId: string | null): RefName {
  return altId === null ? MAIN_REF : `${ALT_PREFIX}${requireId(altId)}`;
}

export function archivedBranchOf(altId: string): RefName {
  return `${ARCHIVE_PREFIX}${requireId(altId)}`;
}

export function milestoneRef(id: string): RefName {
  return `${MILESTONE_PREFIX}${requireId(id)}`;
}

export function mergeSessionRef(opId: string, side: 'ours' | 'theirs' | 'candidate'): RefName {
  return `${MERGE_PREFIX}${requireId(opId)}/${side}`;
}

export function remoteBranchOf(local: RefName): RefName {
  if (!local.startsWith('refs/heads/')) throw new Error('Only branches have remote counterparts.');
  return `${REMOTE_PREFIX}${local.slice('refs/heads/'.length)}`;
}

/** The alternative id a branch names, `null` for main, `undefined` when it is neither. */
export function altIdOf(ref: RefName): string | null | undefined {
  if (ref === MAIN_REF) return null;
  if (!ref.startsWith(ALT_PREFIX)) return undefined;
  const id = ref.slice(ALT_PREFIX.length);
  return isSafeId(id) ? id : undefined;
}

/**
 * `git check-ref-format`, tightened: full names under `refs/`, printable ASCII only, no component
 * starting with `.` or `-`, none ending `.lock`, no `..`, `@{`, `//`, or the characters Git refuses
 * (space, `~^:?*[\`). Anything else is refused rather than quoted.
 */
export function isSafeRefName(ref: string): boolean {
  if (ref.length === 0 || ref.length > 255) return false;
  if (!ref.startsWith('refs/')) return false;
  if (!/^[\x21-\x7e]+$/.test(ref)) return false;
  if (/[~^:?*[\\]/.test(ref)) return false;
  if (ref.includes('..') || ref.includes('@{') || ref.includes('//')) return false;
  if (ref.endsWith('/') || ref.endsWith('.')) return false;
  for (const part of ref.split('/')) {
    if (part.length === 0 || part.startsWith('.') || part.startsWith('-') || part.endsWith('.lock')) return false;
  }
  return true;
}

export function isOid(value: unknown): value is Oid {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}
