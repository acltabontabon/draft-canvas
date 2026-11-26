/**
 * `VersionStore` on isomorphic-git, over `KvFs`: the browser's history backend (ADR-1).
 *
 * Runs in the history worker only. isomorphic-git needs a global `Buffer`; the worker installs one
 * (`bufferGlobal.ts`) before this module loads, and the editor's thread never loads either.
 *
 * What isomorphic-git does not provide is added here and nowhere else: compare-and-swap refs (a
 * read, compare and write under the repository lock — every writer of this origin goes through it),
 * the bounded history walk with `hide`, and the check that a revision's tree is exactly one diagram.
 */
import git from 'isomorphic-git';
import {
  DIAGRAM_PATH,
  HISTORY_LIMITS,
  HistoryError,
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
  type Signature,
  type SnapshotWrite,
  type TagRecord,
  type TagWrite,
  type VersionStore,
} from '../contracts';
import { repoLock, type LockRunner } from '../locks';
import { isOid, isSafeId, isSafeRefName } from '../refs';
import type { KvFs } from './kvfs';

const encoder = new TextEncoder();
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

const META_FILE = 'draft-canvas/repo.json';
const JOURNAL_DIR = 'draft-canvas/journal';
/** Unreachable loose objects younger than this survive maintenance: a write may still name them. */
export const PRUNE_GRACE_MS = 14 * 24 * 60 * 60 * 1000;

function isNotFound(error: unknown): boolean {
  const e = error as { code?: string; name?: string } | null;
  return e?.code === 'NotFoundError' || e?.name === 'NotFoundError' || e?.code === 'ENOENT';
}

function signatureOf(raw: { name: string; email: string; timestamp: number; timezoneOffset: number }): Signature {
  return { name: raw.name, email: raw.email, timestamp: raw.timestamp, timezoneOffset: raw.timezoneOffset };
}

export class IgitStore implements VersionStore {
  readonly gitdir: string;
  private readonly cache = {};

  readonly fs: KvFs;
  readonly repoId: string;
  private readonly lock: LockRunner;

  constructor(fs: KvFs, repoId: string, lock: LockRunner) {
    this.fs = fs;
    this.repoId = repoId;
    this.lock = lock;
    if (!isSafeId(repoId)) throw new HistoryError('invalid', 'Not a history id.');
    this.gitdir = `/${repoId}`;
  }

  /** Creates the bare repository and its `repo.json`. Refuses an id already in use. */
  static async create(fs: KvFs, meta: RepoMeta, lock: LockRunner): Promise<IgitStore> {
    const store = new IgitStore(fs, meta.repoId, lock);
    await lock(repoLock(meta.repoId), async () => {
      if (await exists(fs, store.gitdir)) throw new HistoryError('conflict', 'A history with this id already exists.');
      await fs.mkdirp(store.gitdir);
      await git.init({ fs, gitdir: store.gitdir, bare: true, defaultBranch: 'main' });
      await fs.mkdirp(`${store.gitdir}/${JOURNAL_DIR}`);
      await fs.writeFile(`${store.gitdir}/${META_FILE}`, JSON.stringify(meta));
    });
    return store;
  }

  static async open(fs: KvFs, repoId: string, lock: LockRunner): Promise<IgitStore | undefined> {
    const store = new IgitStore(fs, repoId, lock);
    return (await exists(fs, `${store.gitdir}/${META_FILE}`)) ? store : undefined;
  }

  async meta(): Promise<RepoMeta> {
    const text = (await this.fs.readFile(`${this.gitdir}/${META_FILE}`, 'utf8')) as string;
    return JSON.parse(text) as RepoMeta;
  }

  async writeMeta(meta: RepoMeta): Promise<void> {
    if (meta.repoId !== this.repoId) throw new HistoryError('invalid', 'repo.json names another history.');
    await this.fs.writeFile(`${this.gitdir}/${META_FILE}`, JSON.stringify(meta));
  }

  async writeSnapshot(write: SnapshotWrite): Promise<Oid> {
    const bytes = encoder.encode(write.text);
    if (bytes.byteLength > HISTORY_LIMITS.maxBlobBytes) throw new HistoryError('too-large', 'This diagram is larger than history records.');
    for (const parent of write.parents) if (!isOid(parent)) throw new HistoryError('invalid', 'A parent is not an object id.');
    const { fs, gitdir } = this;
    const blob = await git.writeBlob({ fs, gitdir, blob: bytes });
    const tree = await git.writeTree({ fs, gitdir, tree: [{ mode: '100644', path: DIAGRAM_PATH, oid: blob, type: 'blob' }] });
    return git.writeCommit({
      fs,
      gitdir,
      commit: { message: write.message, tree, parent: write.parents, author: write.author, committer: write.committer },
    });
  }

  async readRef(ref: RefName): Promise<Oid | null> {
    if (!isSafeRefName(ref)) throw new HistoryError('invalid', 'Not a ref Draft Canvas reads.');
    try {
      return await git.resolveRef({ fs: this.fs, gitdir: this.gitdir, ref, depth: 1 });
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async updateRef(update: RefUpdate): Promise<RefUpdateResult> {
    if (!isSafeRefName(update.ref)) throw new HistoryError('invalid', 'Not a ref Draft Canvas writes.');
    if (update.next !== null && !isOid(update.next)) throw new HistoryError('invalid', 'Not an object id.');
    return this.lock(repoLock(this.repoId), async () => {
      const actual = await this.readRef(update.ref);
      if (actual !== update.expected) return { ok: false, actual };
      if (update.next === null) {
        if (actual !== null) await git.deleteRef({ fs: this.fs, gitdir: this.gitdir, ref: update.ref });
      } else {
        // The object must exist before a ref may name it.
        await git.readObject({ fs: this.fs, gitdir: this.gitdir, oid: update.next, format: 'deflated', cache: this.cache });
        await git.writeRef({ fs: this.fs, gitdir: this.gitdir, ref: update.ref, value: update.next, force: true });
      }
      return { ok: true };
    });
  }

  async listRefs(prefix: string): Promise<RefEntry[]> {
    const base = prefix.replace(/\/+$/, '');
    if (!isSafeRefName(`${base}/x`)) throw new HistoryError('invalid', 'Not a ref prefix Draft Canvas reads.');
    const names = await git.listRefs({ fs: this.fs, gitdir: this.gitdir, filepath: base });
    const out: RefEntry[] = [];
    for (const name of names.sort()) {
      const ref = `${base}/${name}`;
      if (!isSafeRefName(ref)) continue;
      const oid = await this.readRef(ref);
      if (oid) out.push({ ref, oid });
    }
    return out;
  }

  async readCommit(oid: Oid): Promise<CommitRecord> {
    if (!isOid(oid)) throw new HistoryError('invalid', 'Not an object id.');
    try {
      const { commit } = await git.readCommit({ fs: this.fs, gitdir: this.gitdir, oid, cache: this.cache });
      return {
        oid,
        tree: commit.tree,
        parents: commit.parent,
        author: signatureOf(commit.author),
        committer: signatureOf(commit.committer),
        message: commit.message,
      };
    } catch (error) {
      if (isNotFound(error)) throw new HistoryError('not-found', 'That revision is not in this history.');
      throw new HistoryError('corrupt', 'That revision could not be read.');
    }
  }

  async readSnapshot(oid: Oid): Promise<string> {
    const commit = await this.readCommit(oid);
    const { tree } = await git.readTree({ fs: this.fs, gitdir: this.gitdir, oid: commit.tree, cache: this.cache });
    const entry = tree.length === 1 ? tree[0] : undefined;
    if (!entry || entry.path !== DIAGRAM_PATH || entry.type !== 'blob' || entry.mode !== '100644') {
      throw new HistoryError('corrupt', 'That revision does not hold a diagram.');
    }
    const { blob } = await git.readBlob({ fs: this.fs, gitdir: this.gitdir, oid: entry.oid, cache: this.cache });
    if (blob.byteLength > HISTORY_LIMITS.maxBlobBytes) throw new HistoryError('too-large', 'That revision is larger than history reads.');
    try {
      return strictUtf8.decode(blob);
    } catch {
      throw new HistoryError('corrupt', 'That revision is not text.');
    }
  }

  async log(query: LogQuery): Promise<CommitRecord[]> {
    const limit = Math.max(0, Math.min(query.limit, HISTORY_LIMITS.maxLogPage));
    const hidden = new Set<Oid>();
    if (query.hide?.length) {
      const stack = [...query.hide];
      while (stack.length > 0 && hidden.size < HISTORY_LIMITS.maxWalk) {
        const oid = stack.pop()!;
        if (hidden.has(oid)) continue;
        hidden.add(oid);
        try {
          stack.push(...(await this.readCommit(oid)).parents);
        } catch (error) {
          if (!(error instanceof HistoryError && error.code === 'not-found')) throw error;
        }
      }
    }
    // Newest committer time first, ties by id, so every backend lists the same order.
    const queue: CommitRecord[] = [];
    const seen = new Set<Oid>();
    const push = async (oid: Oid) => {
      if (seen.has(oid) || hidden.has(oid)) return;
      seen.add(oid);
      queue.push(await this.readCommit(oid));
    };
    for (const oid of query.from) await push(oid);
    const out: CommitRecord[] = [];
    while (queue.length > 0 && out.length < limit) {
      queue.sort(byNewest);
      const next = queue.shift()!;
      out.push(next);
      for (const parent of next.parents) await push(parent);
      if (seen.size > HISTORY_LIMITS.maxWalk) break;
    }
    return out;
  }

  async mergeBases(a: Oid, b: Oid): Promise<Oid[]> {
    const bases = await git.findMergeBase({ fs: this.fs, gitdir: this.gitdir, oids: [a, b], cache: this.cache });
    return [...bases].sort();
  }

  async isAncestor(ancestor: Oid, descendant: Oid): Promise<boolean> {
    if (ancestor === descendant) return true;
    return git.isDescendent({ fs: this.fs, gitdir: this.gitdir, oid: descendant, ancestor, depth: HISTORY_LIMITS.maxWalk, cache: this.cache });
  }

  async writeTag(tag: TagWrite): Promise<Oid> {
    if (!isSafeRefName(tag.ref) || tag.ref !== `refs/tags/${tag.name}`) throw new HistoryError('invalid', 'Not a tag Draft Canvas writes.');
    const oid = await git.writeTag({
      fs: this.fs,
      gitdir: this.gitdir,
      tag: { object: tag.target, type: 'commit', tag: tag.name, tagger: tag.tagger, message: tag.message },
    });
    const result = await this.updateRef({ ref: tag.ref, expected: null, next: oid });
    if (!result.ok) throw new HistoryError('conflict', 'That milestone already exists.');
    return oid;
  }

  async listTags(prefix: string): Promise<TagRecord[]> {
    const out: TagRecord[] = [];
    for (const { ref, oid } of await this.listRefs(prefix)) {
      try {
        const { tag } = await git.readTag({ fs: this.fs, gitdir: this.gitdir, oid, cache: this.cache });
        if (tag.type !== 'commit') continue;
        out.push({ oid, ref, target: tag.object, message: tag.message, tagger: signatureOf(tag.tagger) });
      } catch {
        // A lightweight or unreadable tag is not a milestone.
      }
    }
    return out;
  }

  async journalPut(record: JournalRecord): Promise<void> {
    if (!isSafeId(record.opId)) throw new HistoryError('invalid', 'Not an operation id.');
    await this.fs.writeFile(`${this.gitdir}/${JOURNAL_DIR}/${record.opId}.json`, JSON.stringify(record));
  }

  async journalList(): Promise<JournalRecord[]> {
    const dir = `${this.gitdir}/${JOURNAL_DIR}`;
    if (!(await exists(this.fs, dir))) return [];
    const out: JournalRecord[] = [];
    for (const name of (await this.fs.readdir(dir)).sort()) {
      if (!name.endsWith('.json')) continue;
      try {
        out.push(JSON.parse((await this.fs.readFile(`${dir}/${name}`, 'utf8')) as string) as JournalRecord);
      } catch {
        // An unreadable entry stays on disk for a person to look at; it never blocks the others.
      }
    }
    return out;
  }

  async journalDelete(opId: string): Promise<void> {
    if (!isSafeId(opId)) throw new HistoryError('invalid', 'Not an operation id.');
    try {
      await this.fs.unlink(`${this.gitdir}/${JOURNAL_DIR}/${opId}.json`);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  async usage(): Promise<RepoUsage> {
    const { bytes, files } = await this.fs.usage(this.gitdir);
    return { bytes, objects: files };
  }

  /**
   * Packs every loose object into one pack (no deltas: isomorphic-git writes none) and removes the
   * loose copies, then removes loose objects no ref reaches that are older than the grace period.
   * Held under the repository lock, and refused while a journal entry is open: an operation in
   * flight may hold objects no ref names yet.
   */
  async maintain(now: number = Date.now()): Promise<void> {
    await this.lock(repoLock(this.repoId), async () => {
      if ((await this.journalList()).length > 0) return;
      const loose = await this.looseObjects();
      if (loose.length === 0) return;
      const reachable = await this.reachable();
      const keep = loose.filter((entry) => reachable.has(entry.oid));
      const drop = loose.filter((entry) => !reachable.has(entry.oid) && now - entry.mtimeMs > PRUNE_GRACE_MS);
      if (keep.length > 0) {
        const { filename } = await git.packObjects({ fs: this.fs, gitdir: this.gitdir, oids: keep.map((entry) => entry.oid), write: true, cache: this.cache });
        await git.indexPack({ fs: this.fs, dir: this.gitdir, gitdir: this.gitdir, filepath: `objects/pack/${filename}`, cache: this.cache });
        for (const entry of keep) await this.fs.unlink(entry.path);
      }
      for (const entry of drop) await this.fs.unlink(entry.path);
    });
  }

  private async looseObjects(): Promise<{ oid: Oid; path: string; mtimeMs: number }[]> {
    const out: { oid: Oid; path: string; mtimeMs: number }[] = [];
    const root = `${this.gitdir}/objects`;
    for (const dir of await this.fs.readdir(root)) {
      if (!/^[0-9a-f]{2}$/.test(dir)) continue;
      for (const name of await this.fs.readdir(`${root}/${dir}`)) {
        const oid = `${dir}${name}`;
        if (!isOid(oid)) continue;
        const path = `${root}/${dir}/${name}`;
        out.push({ oid, path, mtimeMs: (await this.fs.stat(path)).mtimeMs });
      }
    }
    return out;
  }

  /** Every object any ref reaches: commits, their trees and blobs, and tags. */
  async reachable(): Promise<Set<Oid>> {
    const seen = new Set<Oid>();
    const stack: Oid[] = [];
    for (const prefix of ['refs/heads', 'refs/tags', 'refs/remotes', 'refs/draft-canvas']) {
      for (const { oid } of await this.listRefs(prefix)) stack.push(oid);
    }
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (seen.size > HISTORY_LIMITS.maxWalk * 4) throw new HistoryError('too-large', 'This history is too large to maintain here.');
      const { type, object } = await git.readObject({ fs: this.fs, gitdir: this.gitdir, oid, cache: this.cache });
      if (type === 'commit') {
        const commit = object as { tree: Oid; parent: Oid[] };
        stack.push(commit.tree, ...commit.parent);
      } else if (type === 'tree') {
        for (const entry of object as { oid: Oid }[]) stack.push(entry.oid);
      } else if (type === 'tag') {
        stack.push((object as { object: Oid }).object);
      }
    }
    return seen;
  }
}

function byNewest(a: CommitRecord, b: CommitRecord): number {
  return b.committer.timestamp - a.committer.timestamp || (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0);
}

async function exists(fs: KvFs, path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}
