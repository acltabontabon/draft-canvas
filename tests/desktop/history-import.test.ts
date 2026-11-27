import git from 'isomorphic-git';
import { describe, expect, it } from 'vitest';
import { createDocument, createNode } from '../../src/document/factory';
import { addNodes } from '../../src/document/operations';
import { DesktopError, type DesktopApi } from '../../src/desktop/api';
import { DesktopHistoryBackend } from '../../src/desktop/history';
import { exportBundle } from '../../src/evolution/browser/bundleIo';
import { IgitStore } from '../../src/evolution/browser/igitStore';
import { KvFs, MemoryKv } from '../../src/evolution/browser/kvfs';
import { HistoryError, type RefEntry, type RepoMeta, type Signature } from '../../src/evolution/contracts';
import { processLocks } from '../../src/evolution/locks';
import { MAIN_REF, milestoneRef } from '../../src/evolution/refs';
import { historyText } from '../../src/evolution/snapshot';

const who = (timestamp: number): Signature => ({ name: 'T', email: 't@draftcanvas.invalid', timestamp, timezoneOffset: 0 });
const meta = (repoId: string): RepoMeta => ({ repoId, documentId: '', title: 'Imported history', createdAt: 0, alternatives: [] });

/**
 * The desktop shell's history commands as far as an import uses them, kept by isomorphic-git. As in
 * `src-tauri/src/history/store.rs`, `historyImportBegin` only indexes the pack, into a staging
 * repository with no refs, and `historyImportCommit` gives it its refs and puts it in place.
 */
function fakeShell() {
  const fs = new KvFs(new MemoryKv());
  const repos = new Map<string, IgitStore>();
  let staged = 0;
  const repo = (name: string) => {
    const found = repos.get(name);
    if (!found) throw new DesktopError('NotFound', 'That history is not on this device.');
    return found;
  };
  const api = {
    historyMeta: async (name: string) => repo(name).meta(),
    historyWriteMeta: async (name: string, value: RepoMeta) => repo(name).writeMeta(value),
    historyReadRef: async (name: string, ref: string) => repo(name).readRef(ref),
    historyListRefs: async (name: string, prefix: string) => repo(name).listRefs(prefix),
    historyReadCommits: async (name: string, oids: string[]) => Promise.all(oids.map((oid) => repo(name).readCommit(oid))),
    historyReadSnapshot: async (name: string, oid: string) => repo(name).readSnapshot(oid),
    historyListTags: async (name: string, prefix: string) => repo(name).listTags(prefix),
    historyRemove: async (name: string) => {
      repo(name);
      repos.delete(name);
    },
    async historyImportBegin(value: RepoMeta, pack: Uint8Array) {
      const store = await IgitStore.create(fs, value, processLocks());
      await fs.writeFile(`${store.gitdir}/objects/pack/pack-import.pack`, pack);
      await git.indexPack({ fs, dir: store.gitdir, gitdir: store.gitdir, filepath: 'objects/pack/pack-import.pack' });
      staged += 1;
      repos.set(`.staging-${staged}`, store);
      return `.staging-${staged}`;
    },
    async historyImportCommit(name: string, refs: RefEntry[]) {
      const store = repo(name);
      for (const entry of refs) if (!(await store.updateRef({ ref: entry.ref, expected: null, next: entry.oid })).ok) throw new DesktopError('Conflict', 'That import already has branches.');
      repos.delete(name);
      repos.set(store.repoId, store);
      return store.repoId;
    },
    historyImportAbort: async (name: string) => {
      repos.delete(name);
    },
  } as unknown as DesktopApi;
  return { api, repos };
}

/** A history of one revision named as a milestone, the way the timeline names one. */
async function milestoned() {
  const store = await IgitStore.create(new KvFs(new MemoryKv()), { ...meta('r_source'), documentId: 'd_source' }, processLocks());
  const doc = addNodes(createDocument('Milestoned'), [createNode({ type: 'service', x: 0, y: 0, id: 'n_api', text: 'API Gateway' })]);
  const first = await store.writeSnapshot({ text: historyText(doc), parents: [], author: who(1), committer: who(1), message: 'Add API Gateway\n' });
  await store.updateRef({ ref: MAIN_REF, expected: null, next: first });
  await store.writeTag({ ref: milestoneRef('m_reviewed'), name: 'milestone/m_reviewed', target: first, tagger: who(2), message: 'Reviewed\n' });
  return { store, first, doc };
}

async function bundleOf(store: IgitStore) {
  return exportBundle(store, [...(await store.listRefs('refs/heads')), ...(await store.listRefs('refs/tags/milestone'))]);
}

describe('importing a history on the desktop', { timeout: 30_000 }, () => {
  it('imports a bundle that carries a milestone, as the desktop exports one', async () => {
    const { store, first, doc } = await milestoned();
    const shell = fakeShell();
    // Milestones were looked up by ref in the staging repository, which has none until it is
    // committed, so every bundle with a milestone was refused, the desktop's own exports included.
    const imported = await new DesktopHistoryBackend(shell.api).importBundle(await bundleOf(store), meta('r_imported'));
    expect(imported).toMatchObject({ repoId: 'r_imported', revisions: 1, documentId: doc.metadata.id });
    expect(imported.refs.map((entry) => entry.ref)).toEqual([MAIN_REF, milestoneRef('m_reviewed')]);
    const kept = shell.repos.get('r_imported')!;
    expect((await kept.listTags('refs/tags/milestone')).map((tag) => tag.target)).toEqual([first]);
    expect(await kept.meta()).toMatchObject({ documentId: doc.metadata.id });
  });

  it('removes the history whole when a milestone tags something that is not a diagram', async () => {
    const { store } = await milestoned();
    const { fs, gitdir } = store;
    const blob = await git.writeBlob({ fs, gitdir, blob: new TextEncoder().encode('not a diagram') });
    const tree = await git.writeTree({ fs, gitdir, tree: [{ mode: '100644', path: 'notes.txt', oid: blob, type: 'blob' }] });
    const stray = await git.writeCommit({ fs, gitdir, commit: { message: 'Notes\n', tree, parent: [], author: who(3), committer: who(3) } });
    await store.writeTag({ ref: milestoneRef('m_stray'), name: 'milestone/m_stray', target: stray, tagger: who(4), message: 'Stray\n' });
    const shell = fakeShell();
    const imported = new DesktopHistoryBackend(shell.api).importBundle(await bundleOf(store), meta('r_imported'));
    await expect(imported).rejects.toBeInstanceOf(HistoryError);
    await expect(imported).rejects.toThrow('That revision does not hold a diagram.');
    expect([...shell.repos.keys()]).toEqual([]);
  });
});
