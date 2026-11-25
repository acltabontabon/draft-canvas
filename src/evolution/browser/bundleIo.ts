/**
 * History export and import as standard Git bundles, on the browser backend.
 *
 * Export writes everything the chosen refs reach into one pack behind a v2 header (`bundle.ts`), so
 * `git clone history.bundle` gives the same branches, revisions and milestones.
 *
 * Import is isolated (ADR-16): the bundle is scanned within limits (`packScan.ts`) before anything
 * inflates it, indexed into a brand-new repository that nothing is bound to yet, and every revision
 * any accepted ref reaches is checked — tree exactly `{ diagram.draftcanvas }`, blob a diagram that
 * `validate` accepts. Only then does the repository get its refs; on any failure it is removed
 * whole. Existing history is never touched by an import: reconciling the two is a separate,
 * explicit merge.
 */
import git from 'isomorphic-git';
import { parseBundle, encodeBundle } from '../bundle';
import { DIAGRAM_PATH, HISTORY_LIMITS, HistoryError, type Oid, type RefEntry, type RepoMeta } from '../contracts';
import type { LockRunner } from '../locks';
import { scanPack, PackRejected } from '../packScan';
import { ALT_PREFIX, ARCHIVE_PREFIX, MAIN_REF, MILESTONE_PREFIX, isSafeId } from '../refs';
import { IgitStore } from './igitStore';
import type { KvFs } from './kvfs';

export const PACK_LIMITS = {
  maxObjects: HISTORY_LIMITS.maxBundleObjects,
  maxObjectBytes: HISTORY_LIMITS.maxBlobBytes,
  maxTotalInflated: 2 * 1024 * 1024 * 1024,
  maxDeltaDepth: 4096,
};

export async function exportBundle(store: IgitStore, refs: RefEntry[]): Promise<Uint8Array> {
  const oids = new Set<Oid>();
  const stack = refs.map((entry) => entry.oid);
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oids.has(oid)) continue;
    oids.add(oid);
    const { type, object } = await git.readObject({ fs: store.fs, gitdir: store.gitdir, oid });
    if (type === 'commit') {
      const commit = object as { tree: Oid; parent: Oid[] };
      stack.push(commit.tree, ...commit.parent);
    } else if (type === 'tree') {
      for (const entry of object as { oid: Oid }[]) stack.push(entry.oid);
    } else if (type === 'tag') {
      stack.push((object as { object: Oid }).object);
    }
  }
  const { packfile } = await git.packObjects({ fs: store.fs, gitdir: store.gitdir, oids: [...oids].sort() });
  const head = refs.find((entry) => entry.ref === MAIN_REF)?.oid ?? null;
  return encodeBundle(refs, head, packfile!);
}

/** Which bundle refs an import keeps, and under what name. Anything else is reported, not created. */
export function acceptedRefs(refs: RefEntry[], head: Oid | null): { accepted: RefEntry[]; ignored: string[] } {
  const accepted: RefEntry[] = [];
  const ignored: string[] = [];
  for (const entry of refs) {
    const keep =
      entry.ref === MAIN_REF ||
      (entry.ref.startsWith(ALT_PREFIX) && isSafeId(entry.ref.slice(ALT_PREFIX.length))) ||
      (entry.ref.startsWith(ARCHIVE_PREFIX) && isSafeId(entry.ref.slice(ARCHIVE_PREFIX.length))) ||
      (entry.ref.startsWith(MILESTONE_PREFIX) && isSafeId(entry.ref.slice(MILESTONE_PREFIX.length)));
    if (keep) accepted.push(entry);
    else ignored.push(entry.ref);
  }
  // A bundle made elsewhere may call its primary branch something else: `HEAD` says which.
  if (!accepted.some((entry) => entry.ref === MAIN_REF) && head) accepted.push({ ref: MAIN_REF, oid: head });
  return { accepted, ignored };
}

export interface ImportResult {
  store: IgitStore;
  refs: RefEntry[];
  ignored: string[];
  revisions: number;
}

/**
 * Imports a full bundle into a new repository described by `meta`. `validateText` is the document
 * validator (`readHistoryText`), injected so this module stays free of the document model.
 */
export async function importBundle(
  fs: KvFs,
  lock: LockRunner,
  bytes: Uint8Array,
  meta: RepoMeta,
  validateText: (text: string) => void,
): Promise<ImportResult> {
  const { header, packStart } = parseBundle(bytes);
  if (header.prerequisites.length > 0) {
    throw new HistoryError('unsupported-format', 'This is an incremental bundle: it needs earlier history this device does not have.');
  }
  const { accepted, ignored } = acceptedRefs(header.refs, header.head);
  if (!accepted.some((entry) => entry.ref === MAIN_REF)) throw new HistoryError('invalid', 'This bundle has no primary branch to import.');
  const pack = bytes.subarray(packStart);
  try {
    scanPack(pack, PACK_LIMITS);
  } catch (error) {
    if (error instanceof PackRejected) throw new HistoryError('corrupt', error.message);
    throw error;
  }

  const store = await IgitStore.create(fs, meta, lock);
  try {
    const name = `pack-${[...pack.subarray(pack.length - 20)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
    await fs.writeFile(`${store.gitdir}/objects/pack/${name}.pack`, pack);
    try {
      await git.indexPack({ fs, dir: store.gitdir, gitdir: store.gitdir, filepath: `objects/pack/${name}.pack` });
    } catch {
      throw new HistoryError('corrupt', 'The history in this bundle is damaged.');
    }
    const revisions = await verifyReachable(store, accepted, validateText);
    for (const entry of accepted) {
      const result = await store.updateRef({ ref: entry.ref, expected: null, next: entry.oid });
      if (!result.ok) throw new HistoryError('conflict', 'The new history changed while it was being imported.');
    }
    return { store, refs: accepted, ignored, revisions };
  } catch (error) {
    await fs.removeTree(store.gitdir);
    throw error;
  }
}

async function verifyReachable(store: IgitStore, refs: RefEntry[], validateText: (text: string) => void): Promise<number> {
  const commits = new Set<Oid>();
  const checkedBlobs = new Set<Oid>();
  const stack: Oid[] = [];
  for (const entry of refs) {
    const { type, object } = await git.readObject({ fs: store.fs, gitdir: store.gitdir, oid: entry.oid }).catch(() => {
      throw new HistoryError('corrupt', 'A branch in this bundle names a revision it does not contain.');
    });
    if (entry.ref.startsWith(MILESTONE_PREFIX)) {
      if (type !== 'tag' || (object as { type: string }).type !== 'commit') throw new HistoryError('invalid', 'A milestone in this bundle is not a tagged revision.');
      stack.push((object as { object: Oid }).object);
    } else {
      if (type !== 'commit') throw new HistoryError('invalid', 'A branch in this bundle does not name a revision.');
      stack.push(entry.oid);
    }
  }
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (commits.has(oid)) continue;
    commits.add(oid);
    if (commits.size > HISTORY_LIMITS.maxWalk) throw new HistoryError('too-large', 'This history has more revisions than Draft Canvas imports.');
    const commit = await store.readCommit(oid);
    const { tree } = await git.readTree({ fs: store.fs, gitdir: store.gitdir, oid: commit.tree });
    const entry = tree.length === 1 ? tree[0]! : undefined;
    if (!entry || entry.path !== DIAGRAM_PATH || entry.type !== 'blob' || entry.mode !== '100644') {
      throw new HistoryError('invalid', 'A revision in this bundle holds something other than one diagram.');
    }
    if (!checkedBlobs.has(entry.oid)) {
      checkedBlobs.add(entry.oid);
      validateText(await store.readSnapshot(oid));
    }
    stack.push(...commit.parents);
  }
  return commits.size;
}
