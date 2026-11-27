/**
 * The version-control contract Canvas Evolution is written against, and nothing more.
 *
 * Draft Canvas owns the architectural meaning of history — what a revision is, which changes it
 * records, how two architectures merge. It does not own Git: the browser backend is isomorphic-git
 * in the history worker, the desktop backend is gix behind the desktop shell. Both implement
 * `VersionStore`, and `tests/evolution/igit-store.test.ts` plus the Rust tests hold both to the same
 * fixtures, `tests/fixtures/evolution/contract.json` (docs/reference/evolution.md, ADR-1).
 *
 * Everything here is plain data: it crosses a worker boundary and an IPC boundary unchanged.
 */

/** A 40-character lowercase SHA-1 object id. SHA-256 repositories are refused by name. */
export type Oid = string;

/** A full ref name, `refs/heads/main`. Always validated with `refs.ts` before it reaches a backend. */
export type RefName = string;

/** The one path every revision's tree holds: the canonical file, readable by Draft Canvas as is. */
export const DIAGRAM_PATH = 'diagram.draftcanvas';

/** Who a Git signature names. Never a fabricated person: see `identity.ts` and `trailers.ts`. */
export interface Signature {
  name: string;
  email: string;
  /** Seconds since the epoch, as Git stores it. */
  timestamp: number;
  /** Minutes, as `Date.getTimezoneOffset()` reports them (positive west of UTC). */
  timezoneOffset: number;
}

export interface CommitRecord {
  oid: Oid;
  tree: Oid;
  parents: Oid[];
  author: Signature;
  committer: Signature;
  message: string;
}

/** A revision to record: the canonical text, its parents, and who records it. */
export interface SnapshotWrite {
  text: string;
  parents: Oid[];
  author: Signature;
  committer: Signature;
  message: string;
}

/**
 * A compare-and-swap ref update. `expected: null` means "must not exist yet"; `next: null` deletes.
 * A backend applies it exactly when the ref still holds `expected`, and says so otherwise — it never
 * overwrites a value someone else wrote in between.
 */
export interface RefUpdate {
  ref: RefName;
  expected: Oid | null;
  next: Oid | null;
}

export type RefUpdateResult = { ok: true } | { ok: false; actual: Oid | null };

export interface RefEntry {
  ref: RefName;
  oid: Oid;
}

export interface TagWrite {
  /** The tag's ref, `refs/tags/milestone/<id>`. */
  ref: RefName;
  target: Oid;
  /** The tag's own short name (the part after `refs/tags/`). */
  name: string;
  tagger: Signature;
  message: string;
}

export interface TagRecord {
  oid: Oid;
  ref: RefName;
  target: Oid;
  message: string;
  tagger: Signature;
}

export interface LogQuery {
  /** Commits reachable from these, newest committer time first. */
  from: Oid[];
  /** At most this many. Backends cap it at `LIMITS.maxLogPage` regardless. */
  limit: number;
  /** Stop at (and leave out) these and everything they reach. */
  hide?: Oid[];
}

export interface RepoUsage {
  bytes: number;
  objects: number;
}

/** A journal entry: one multi-step operation and the last step it durably reached. See `journal.ts`. */
export interface JournalRecord {
  opId: string;
  kind: string;
  step: string;
  at: number;
  /** Operation-specific, plain JSON. */
  data: Record<string, unknown>;
}

/** What `repo.json` says about a managed history repository. */
export interface RepoMeta {
  repoId: string;
  /** The `metadata.id` of the document the history was started for: a lineage hint, never identity. */
  documentId: string;
  title: string;
  createdAt: number;
  /** The repo this one was duplicated or imported from, with the commit it started at. */
  lineage?: { repoId: string; oid: Oid };
  /** Alternatives by stable id: their names are display only. */
  alternatives: AlternativeMeta[];
  /**
   * Capture is off for every copy of this history. Only read: a pause is kept on the copy's
   * `Binding` now, and resuming any copy lifts this one, written by earlier versions.
   */
  paused?: boolean;
  remote?: RemoteMeta;
}

export interface AlternativeMeta {
  altId: string;
  name: string;
  createdAt: number;
  /** The commit it branched from, when it was created. */
  from: Oid | null;
  archived?: boolean;
}

export type PublishPolicy = 'manual' | 'periodic' | 'idle' | 'session-end' | 'milestones';

export interface RemoteMeta {
  /** The URL as the person entered it, validated; never containing credentials. */
  url: string;
  policy: PublishPolicy;
  /** Alternatives the person chose to publish too. `main` always is when publishing at all. */
  publishAlternatives: string[];
  /** The person saw and accepted the first-publish preview for this destination. */
  confirmedDestination?: string;
}

/**
 * The narrow interface both backends implement for one repository. Each method is atomic on its own;
 * operations spanning several of them are made recoverable by `journal.ts`, never by assuming a
 * backend transaction covers application state too.
 */
export interface VersionStore {
  readonly repoId: string;
  meta(): Promise<RepoMeta>;
  /**
   * Replaces `repo.json` atomically. A history another tab or window may have open is changed only
   * through `HistoryService.changeMeta`, which reads it again under the repository's lock.
   */
  writeMeta(meta: RepoMeta): Promise<void>;
  /** Blob, tree and commit, content-addressed: writing the same snapshot twice writes nothing new. */
  writeSnapshot(write: SnapshotWrite): Promise<Oid>;
  updateRef(update: RefUpdate): Promise<RefUpdateResult>;
  readRef(ref: RefName): Promise<Oid | null>;
  listRefs(prefix: string): Promise<RefEntry[]>;
  readCommit(oid: Oid): Promise<CommitRecord>;
  /** The diagram text of a commit, after checking its tree is exactly `{ DIAGRAM_PATH }`. */
  readSnapshot(oid: Oid): Promise<string>;
  log(query: LogQuery): Promise<CommitRecord[]>;
  mergeBases(a: Oid, b: Oid): Promise<Oid[]>;
  isAncestor(ancestor: Oid, descendant: Oid): Promise<boolean>;
  writeTag(tag: TagWrite): Promise<Oid>;
  listTags(prefix: string): Promise<TagRecord[]>;
  journalPut(record: JournalRecord): Promise<void>;
  journalList(): Promise<JournalRecord[]>;
  journalDelete(opId: string): Promise<void>;
  usage(): Promise<RepoUsage>;
  /** Packs loose objects and prunes unreachable ones older than the grace period; see ADR-15. */
  maintain(): Promise<void>;
}

/**
 * A working copy's binding to the history that records it (ADR-2). History follows the copy, never
 * `metadata.id` alone: two files with the same id are two copies until the person says otherwise.
 */
export interface Binding {
  copyId: string;
  repoId: string;
  /** The alternative this copy is on; `null` is `main`. */
  altId: string | null;
  /** The document id the copy had when it was bound, to notice a copy that gained a new id. */
  documentId: string;
  /** The ref value this copy last saw, to tell another copy moving the same history apart. */
  lastSeen: Oid | null;
  at: number;
  /**
   * Recording is paused for this copy (the history it has stays). Kept here, like `altId`, and not
   * in the shared `repo.json`: two copies may continue one history, and pausing one paused both.
   */
  paused?: boolean;
}

/** Hard limits every backend enforces on untrusted history. */
export const HISTORY_LIMITS = {
  /** A diagram blob is a `.draftcanvas` file: the same cap `parseDocument` applies. */
  maxBlobBytes: 24 * 1024 * 1024,
  maxLogPage: 500,
  /** How far a merge-base or ancestry walk may go before giving up. */
  maxWalk: 200_000,
  /** Bundle import. */
  maxBundleBytes: 512 * 1024 * 1024,
  maxBundleObjects: 2_000_000,
  maxBundleRefs: 10_000,
  maxTrailerValue: 200,
  maxMessageBytes: 16 * 1024,
} as const;

export type HistoryErrorCode = 'not-found' | 'corrupt' | 'unsupported-format' | 'conflict' | 'quota' | 'locked' | 'unavailable' | 'invalid' | 'too-large';

export class HistoryError extends Error {
  readonly code: HistoryErrorCode;

  constructor(code: HistoryErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'HistoryError';
  }
}
