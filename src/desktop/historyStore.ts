/**
 * Canvas Evolution's desktop backend, as a `VersionStore`: each method is one shell command
 * (`src-tauri/src/history/`, gix over bare repositories in the app's own data folder). Nothing is
 * decided here; the shell checks every id, ref and object id itself, and the Rust tests hold it to
 * the same fixtures as the browser backend.
 *
 * The shell's refusals arrive as `DesktopError`s and leave as `HistoryError`s, so code above the
 * contract never learns which backend it talks to.
 */
import {
  HistoryError,
  type Binding,
  type CommitRecord,
  type JournalRecord,
  type LogQuery,
  type Oid,
  type RefEntry,
  type RefName,
  type RefUpdate,
  type RefUpdateResult,
  type RepoMeta,
  type RepoUsage,
  type SnapshotWrite,
  type TagRecord,
  type TagWrite,
  type VersionStore,
} from '../evolution/contracts';
import { DesktopError, type AppErrorKind, type DesktopApi } from './api';

const CODES: Record<AppErrorKind, HistoryError['code']> = {
  NotFound: 'not-found',
  Conflict: 'conflict',
  AlreadyExists: 'conflict',
  Corrupt: 'corrupt',
  NotADocument: 'corrupt',
  Unsupported: 'unsupported-format',
  Invalid: 'invalid',
  InvalidHandle: 'invalid',
  InvalidPath: 'invalid',
  TooLarge: 'too-large',
  DiskFull: 'quota',
  PermissionDenied: 'unavailable',
  ReadOnly: 'unavailable',
  Io: 'unavailable',
};

async function translated<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof DesktopError) throw new HistoryError(CODES[error.kind] ?? 'unavailable', error.message);
    throw error;
  }
}

export class DesktopVersionStore implements VersionStore {
  private readonly api: DesktopApi;
  /** A history id, or an import's `.staging-<id>` while it is being checked (reads only). */
  readonly repoId: string;

  constructor(api: DesktopApi, repoId: string) {
    this.api = api;
    this.repoId = repoId;
  }

  meta(): Promise<RepoMeta> {
    return translated(this.api.historyMeta(this.repoId));
  }

  writeMeta(meta: RepoMeta): Promise<void> {
    return translated(this.api.historyWriteMeta(this.repoId, meta));
  }

  writeSnapshot(write: SnapshotWrite): Promise<Oid> {
    return translated(this.api.historyWriteSnapshot(this.repoId, write));
  }

  updateRef(update: RefUpdate): Promise<RefUpdateResult> {
    return translated(this.api.historyUpdateRef(this.repoId, update));
  }

  readRef(ref: RefName): Promise<Oid | null> {
    return translated(this.api.historyReadRef(this.repoId, ref));
  }

  listRefs(prefix: string): Promise<RefEntry[]> {
    return translated(this.api.historyListRefs(this.repoId, prefix));
  }

  async readCommit(oid: Oid): Promise<CommitRecord> {
    const [commit] = await this.readCommits([oid]);
    if (!commit) throw new HistoryError('not-found', 'That revision is not in this history.');
    return commit;
  }

  /** Many commits in one round trip (not part of the contract; the shell caps a batch at 1000). */
  readCommits(oids: Oid[]): Promise<CommitRecord[]> {
    return translated(this.api.historyReadCommits(this.repoId, oids));
  }

  readSnapshot(oid: Oid): Promise<string> {
    return translated(this.api.historyReadSnapshot(this.repoId, oid));
  }

  log(query: LogQuery): Promise<CommitRecord[]> {
    return translated(this.api.historyLog(this.repoId, query));
  }

  mergeBases(a: Oid, b: Oid): Promise<Oid[]> {
    return translated(this.api.historyMergeBases(this.repoId, a, b));
  }

  isAncestor(ancestor: Oid, descendant: Oid): Promise<boolean> {
    return translated(this.api.historyIsAncestor(this.repoId, ancestor, descendant));
  }

  writeTag(tag: TagWrite): Promise<Oid> {
    return translated(this.api.historyWriteTag(this.repoId, tag));
  }

  listTags(prefix: string): Promise<TagRecord[]> {
    return translated(this.api.historyListTags(this.repoId, prefix));
  }

  journalPut(record: JournalRecord): Promise<void> {
    return translated(this.api.historyJournalPut(this.repoId, record));
  }

  journalList(): Promise<JournalRecord[]> {
    return translated(this.api.historyJournalList(this.repoId));
  }

  journalDelete(opId: string): Promise<void> {
    return translated(this.api.historyJournalDelete(this.repoId, opId));
  }

  usage(): Promise<RepoUsage> {
    return translated(this.api.historyUsage(this.repoId));
  }

  /** Does nothing while a journal entry is open, as the browser backend does. */
  async maintain(): Promise<void> {
    await translated(this.api.historyMaintain(this.repoId));
  }
}

export function listHistories(api: DesktopApi): Promise<RepoMeta[]> {
  return translated(api.historyList());
}

export async function createHistory(api: DesktopApi, meta: RepoMeta): Promise<DesktopVersionStore> {
  await translated(api.historyCreate(meta));
  return new DesktopVersionStore(api, meta.repoId);
}

/** The history with this id, or `undefined` when this device has none. */
export async function openHistory(api: DesktopApi, repoId: string): Promise<DesktopVersionStore | undefined> {
  const store = new DesktopVersionStore(api, repoId);
  try {
    await store.meta();
    return store;
  } catch (error) {
    if (error instanceof HistoryError && error.code === 'not-found') return undefined;
    throw error;
  }
}

export function removeHistory(api: DesktopApi, repoId: string): Promise<void> {
  return translated(api.historyRemove(repoId));
}

/** A version 2 pack of everything `tips` reach; `bundle.ts` puts the bundle header in front. */
export function exportPack(api: DesktopApi, repoId: string, tips: Oid[]): Promise<Uint8Array> {
  return translated(api.historyPackReachable(repoId, tips));
}

/**
 * Indexes an imported pack into a staging repository nothing is bound to. Read and check it through
 * the returned store, then `importCommit` or `importAbort`.
 */
export async function importBegin(api: DesktopApi, meta: RepoMeta, pack: Uint8Array): Promise<DesktopVersionStore> {
  const staging = await translated(api.historyImportBegin(meta, pack));
  return new DesktopVersionStore(api, staging);
}

/** Gives the checked import its refs and makes it an ordinary history; returns that history. */
export async function importCommit(api: DesktopApi, staging: DesktopVersionStore, refs: RefEntry[]): Promise<DesktopVersionStore> {
  const repoId = await translated(api.historyImportCommit(staging.repoId, refs));
  return new DesktopVersionStore(api, repoId);
}

export function importAbort(api: DesktopApi, staging: DesktopVersionStore): Promise<void> {
  return translated(api.historyImportAbort(staging.repoId));
}

export async function getBinding(api: DesktopApi, copyId: string): Promise<Binding | undefined> {
  return (await translated(api.historyBindingGet(copyId))) ?? undefined;
}

export function putBinding(api: DesktopApi, binding: Binding): Promise<void> {
  return translated(api.historyBindingPut(binding));
}

export function deleteBinding(api: DesktopApi, copyId: string): Promise<void> {
  return translated(api.historyBindingDelete(copyId));
}

export function listBindings(api: DesktopApi): Promise<Binding[]> {
  return translated(api.historyBindingList());
}
