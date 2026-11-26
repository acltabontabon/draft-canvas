import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportBundle, importBundle } from '../../src/evolution/browser/bundleIo';
import { IgitStore } from '../../src/evolution/browser/igitStore';
import { KvFs, MemoryKv } from '../../src/evolution/browser/kvfs';
import type { RepoMeta, Signature } from '../../src/evolution/contracts';
import { HistoryError } from '../../src/evolution/contracts';
import { processLocks } from '../../src/evolution/locks';
import { MAIN_REF } from '../../src/evolution/refs';
import { HAS_GIT, git, gitOk, scratch } from './realGit';

const FIXTURES = join(__dirname, '..', 'fixtures', 'evolution', 'contract.json');

interface Fixture {
  name: string;
  revisions: { text: string; message: string; time: number }[];
  expected: { commits: string[] };
}

export const SIGNATURE = (time: number): Signature => ({ name: 'Fixture', email: 'fixture@draftcanvas.invalid', timestamp: time, timezoneOffset: 0 });

function meta(repoId: string): RepoMeta {
  return { repoId, documentId: 'd_fixture', title: 'Fixture', createdAt: 0, alternatives: [] };
}

async function freshStore(repoId = 'r_test'): Promise<IgitStore> {
  return IgitStore.create(new KvFs(new MemoryKv(), () => 1_700_000_000_000), meta(repoId), processLocks());
}

/** Writes a fixture's revisions as a linear history and returns the commit ids. */
async function record(store: IgitStore, fixture: Fixture): Promise<string[]> {
  const commits: string[] = [];
  let parent: string | null = null;
  for (const revision of fixture.revisions) {
    const oid = await store.writeSnapshot({
      text: revision.text,
      parents: parent ? [parent] : [],
      author: SIGNATURE(revision.time),
      committer: SIGNATURE(revision.time),
      message: revision.message,
    });
    const update = await store.updateRef({ ref: MAIN_REF, expected: parent, next: oid });
    expect(update.ok).toBe(true);
    commits.push(oid);
    parent = oid;
  }
  return commits;
}

const fixtures: Fixture[] = JSON.parse(readFileSync(FIXTURES, 'utf8'));

describe('the browser history backend (isomorphic-git)', () => {
  it.each(fixtures.map((fixture) => [fixture.name, fixture] as const))('writes the contract commit ids for %s', async (_name, fixture) => {
    const store = await freshStore();
    expect(await record(store, fixture)).toEqual(fixture.expected.commits);
    const last = fixture.revisions.length - 1;
    expect(await store.readSnapshot(fixture.expected.commits[last]!)).toBe(fixture.revisions[last]!.text);
  });

  it('updates a ref only from the value it expects', async () => {
    const store = await freshStore();
    const [first] = await record(store, fixtures[0]!);
    expect(await store.updateRef({ ref: 'refs/heads/alt/a1', expected: null, next: first! })).toEqual({ ok: true });
    expect(await store.updateRef({ ref: 'refs/heads/alt/a1', expected: null, next: first! })).toEqual({ ok: false, actual: first });
    expect(await store.updateRef({ ref: 'refs/heads/alt/a1', expected: first!, next: null })).toEqual({ ok: true });
    expect(await store.readRef('refs/heads/alt/a1')).toBeNull();
    await expect(store.updateRef({ ref: 'refs/heads/../x', expected: null, next: first! })).rejects.toBeInstanceOf(HistoryError);
  });

  it('lets exactly one of two racing writers move a branch', async () => {
    const store = await freshStore();
    const first = (await record(store, fixtures[0]!)).at(-1);
    const a = await store.writeSnapshot({ text: 'a\n', parents: [first!], author: SIGNATURE(2), committer: SIGNATURE(2), message: 'a\n' });
    const b = await store.writeSnapshot({ text: 'b\n', parents: [first!], author: SIGNATURE(2), committer: SIGNATURE(2), message: 'b\n' });
    const results = await Promise.all([
      store.updateRef({ ref: MAIN_REF, expected: first!, next: a }),
      store.updateRef({ ref: MAIN_REF, expected: first!, next: b }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
  });

  it('lists history newest first and hides what it is told to', async () => {
    const store = await freshStore();
    const commits = await record(store, fixtures[0]!);
    const all = await store.log({ from: [commits.at(-1)!], limit: 100 });
    expect(all.map((commit) => commit.oid)).toEqual([...commits].reverse());
    const after = await store.log({ from: [commits.at(-1)!], limit: 100, hide: [commits[0]!] });
    expect(after.map((commit) => commit.oid)).toEqual(commits.slice(1).reverse());
    expect(await store.isAncestor(commits[0]!, commits.at(-1)!)).toBe(true);
    expect(await store.isAncestor(commits.at(-1)!, commits[0]!)).toBe(false);
  });

  it('refuses a revision whose tree holds anything but the diagram', async () => {
    const store = await freshStore();
    const git_ = await import('isomorphic-git');
    const blob = await git_.writeBlob({ fs: store.fs, gitdir: store.gitdir, blob: new TextEncoder().encode('x') });
    const tree = await git_.writeTree({ fs: store.fs, gitdir: store.gitdir, tree: [{ mode: '100644', path: 'other.txt', oid: blob, type: 'blob' }] });
    const commit = await git_.writeCommit({ fs: store.fs, gitdir: store.gitdir, commit: { message: 'x\n', tree, parent: [], author: SIGNATURE(1), committer: SIGNATURE(1) } });
    await expect(store.readSnapshot(commit)).rejects.toMatchObject({ code: 'corrupt' });
  });

  it('keeps reachable history through maintenance and prunes only old unreachable objects', async () => {
    const store = await freshStore();
    const commits = await record(store, fixtures[0]!);
    const orphan = await store.writeSnapshot({ text: 'orphan\n', parents: [], author: SIGNATURE(5), committer: SIGNATURE(5), message: 'o\n' });
    await store.maintain(1_700_000_000_000 + 1000);
    // Too young to prune: still readable.
    expect((await store.readCommit(orphan)).oid).toBe(orphan);
    await store.maintain(1_700_000_000_000 + 30 * 24 * 3600 * 1000);
    await expect(store.readCommit(orphan)).rejects.toMatchObject({ code: 'not-found' });
    for (const oid of commits) expect((await store.readCommit(oid)).oid).toBe(oid);
    expect(await store.readSnapshot(commits.at(-1)!)).toBe(fixtures[0]!.revisions.at(-1)!.text);
  });

  it('refuses maintenance while an operation is journaled', async () => {
    const store = await freshStore();
    await record(store, fixtures[0]!);
    await store.journalPut({ opId: 'op1', kind: 'restore', step: 'prepared', at: 1, data: {} });
    const before = await store.usage();
    await store.maintain(Number.MAX_SAFE_INTEGER);
    expect(await store.usage()).toEqual(before);
    await store.journalDelete('op1');
    expect(await store.journalList()).toEqual([]);
  });
});

describe.skipIf(!HAS_GIT)('interoperability with standard Git', { timeout: 60_000 }, () => {
  it.each(fixtures.map((fixture) => [fixture.name, fixture] as const))('real git computes the same ids for %s', (_name, fixture) => {
    const { dir, done } = scratch();
    try {
      gitOk(dir, ['init', '--bare', '-q', 'repo.git']);
      const repo = join(dir, 'repo.git');
      let parent: string | null = null;
      const commits: string[] = [];
      for (const revision of fixture.revisions) {
        const blob = gitOk(repo, ['hash-object', '-w', '--stdin'], revision.text).trim();
        const tree = gitOk(repo, ['mktree'], `100644 blob ${blob}\tdiagram.draftcanvas\n`).trim();
        const result = git(repo, ['-c', `user.name=Fixture`, 'commit-tree', tree, ...(parent ? ['-p', parent] : []), '-F', '-'], revision.message);
        expect(result.status).toBe(0);
        commits.push(result.stdout.trim());
        parent = commits.at(-1)!;
      }
      // commit-tree takes its dates from the environment (fixed at 1700000000): fixtures use that time.
      expect(commits).toEqual(fixture.expected.commits);
    } finally {
      done();
    }
  });

  it('exports a bundle Git can clone, fsck and read', async () => {
    const store = await freshStore();
    const fixture = fixtures[0]!;
    const commits = await record(store, fixture);
    const bundle = await exportBundle(store, [{ ref: MAIN_REF, oid: commits.at(-1)! }]);
    const { dir, done } = scratch();
    try {
      writeFileSync(join(dir, 'history.bundle'), bundle);
      gitOk(dir, ['clone', '-q', 'history.bundle', 'clone']);
      const clone = join(dir, 'clone');
      gitOk(clone, ['bundle', 'verify', '../history.bundle']);
      gitOk(clone, ['fsck', '--strict']);
      expect(gitOk(clone, ['log', '--format=%H']).trim().split('\n')).toEqual([...commits].reverse());
      expect(gitOk(clone, ['show', 'main:diagram.draftcanvas'])).toBe(fixture.revisions.at(-1)!.text);
      expect(existsSync(join(clone, 'diagram.draftcanvas'))).toBe(true);
    } finally {
      done();
    }
  });

  it('imports a bundle Git wrote, deltas included, and refuses a damaged one', async () => {
    const fixture = fixtures[0]!;
    const { dir, done } = scratch();
    try {
      gitOk(dir, ['init', '-q', 'work']);
      const work = join(dir, 'work');
      for (const revision of fixture.revisions) {
        writeFileSync(join(work, 'diagram.draftcanvas'), revision.text);
        gitOk(work, ['add', 'diagram.draftcanvas']);
        gitOk(work, ['commit', '-q', '-F', '-'], revision.message);
      }
      gitOk(work, ['gc', '-q', '--aggressive']);
      gitOk(work, ['bundle', 'create', '../made.bundle', '--all']);
      const bytes = new Uint8Array(readFileSync(join(dir, 'made.bundle')));
      const fs = new KvFs(new MemoryKv());
      const result = await importBundle(fs, processLocks(), bytes, meta('r_imported'), () => {});
      const tip = gitOk(work, ['rev-parse', 'HEAD']).trim();
      expect(await result.store.readRef(MAIN_REF)).toBe(tip);
      expect(await result.store.readSnapshot(tip)).toBe(fixture.revisions.at(-1)!.text);
      expect(result.revisions).toBe(fixture.revisions.length);

      const damaged = bytes.slice();
      damaged[damaged.length - 40] = damaged[damaged.length - 40]! ^ 0xff;
      await expect(importBundle(new KvFs(new MemoryKv()), processLocks(), damaged, meta('r_bad'), () => {})).rejects.toBeInstanceOf(HistoryError);
    } finally {
      done();
    }
  });
});
