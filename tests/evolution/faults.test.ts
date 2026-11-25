import { beforeEach, describe, expect, it } from 'vitest';
import { createDocument, createNode } from '../../src/document/factory';
import { addNodes, updateNode } from '../../src/document/operations';
import type { DraftDocument } from '../../src/document/types';
import type { HistoryBackend } from '../../src/evolution/backend';
import { BrowserBackend, MemoryState } from '../../src/evolution/browser/backend';
import { KvFs, MemoryKv } from '../../src/evolution/browser/kvfs';
import { HistoryError, type VersionStore } from '../../src/evolution/contracts';
import { processLocks } from '../../src/evolution/locks';
import { MAIN_REF } from '../../src/evolution/refs';
import { DEFAULT_SCHEDULE } from '../../src/evolution/scheduler';
import { compute } from '../../src/evolution/workerHost';
import { INITIAL_EVOLUTION, useEvolutionStore } from '../../src/store/evolution/evolutionStore';
import { HistoryService } from '../../src/store/evolution/service';

/**
 * Fault injection: history fails in the ways storage and concurrency fail, and the person's work
 * survives each one — drawing never waits, nothing recorded is lost, and recording resumes.
 */

async function settle(rounds = 40) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A store whose next calls of one method fail, once or until told otherwise. */
function faulty(store: VersionStore, faults: { method: keyof VersionStore; error: Error; times: number }[]): VersionStore {
  return new Proxy(store, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const fault = faults.find((candidate) => candidate.method === key && candidate.times > 0);
        if (fault) {
          fault.times -= 1;
          return Promise.reject(fault.error);
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

function backendWith(inner: BrowserBackend, wrap: (store: VersionStore) => VersionStore): HistoryBackend {
  return new Proxy(inner, {
    get(target, key, receiver) {
      if (key === 'create') return async (meta: Parameters<HistoryBackend['create']>[0]) => wrap(await target.create(meta));
      if (key === 'open') return async (id: string) => {
        const store = await target.open(id);
        return store ? wrap(store) : undefined;
      };
      const value = Reflect.get(target, key, receiver) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as HistoryBackend;
}

function service(backend: () => HistoryBackend, file: () => DraftDocument, generation: () => number, recordable: () => boolean = () => true) {
  let now = 1_700_000_000_000;
  return {
    advance: (ms: number) => (now += ms),
    history: new HistoryService({
      backend,
      compute,
      editor: { file, generation, atBoundary: () => true, recordable },
      // Timers never fire on their own here: each test asks for captures explicitly.
      clock: { now: () => now, setTimeout: () => 0, clearTimeout: () => {} },
      schedule: () => DEFAULT_SCHEDULE,
      enabled: () => true,
      signature: (at) => ({ name: 'T', email: 't@draftcanvas.invalid', timestamp: Math.floor(at / 1000), timezoneOffset: 0 }),
      holdCopy: async () => () => {},
      firstUseSeen: () => true,
    }),
  };
}

const doc = () => addNodes(createDocument('Faults'), [createNode({ type: 'service', x: 0, y: 0, id: 'n_a', text: 'A' })]);

beforeEach(() => useEvolutionStore.setState(INITIAL_EVOLUTION));

describe('history under failure', () => {
  it('pauses on full storage, says so, and resumes without losing the edit', async () => {
    const inner = new BrowserBackend(new KvFs(new MemoryKv()), new MemoryState(), processLocks());
    const faults = [{ method: 'writeSnapshot' as const, error: new HistoryError('quota', 'Storage for history is full.'), times: 1 }];
    let file = doc();
    let generation = 1;
    const { history } = service(() => backendWith(inner, (store) => faulty(store, faults)), () => file, () => generation);
    await history.attach({ kind: 'library', documentId: file.metadata.id });
    await history.flush().catch(() => undefined);
    expect(useEvolutionStore.getState().capture).toMatchObject({ kind: 'failed', quota: true });
    // Drawing goes on meanwhile; nothing waits on history.
    file = updateNode(file, 'n_a', { text: 'A2' });
    generation += 1;
    history.noteEdit();
    await history.flush();
    expect(useEvolutionStore.getState().capture.kind).toBe('up-to-date');
    const [meta] = await inner.list();
    const store = (await inner.open(meta!.repoId))!;
    const tip = (await store.readRef(MAIN_REF))!;
    expect(await store.readSnapshot(tip)).toContain('"A2"');
  });

  it('recovers when the branch could not be moved after the objects were written, without duplicates', async () => {
    const inner = new BrowserBackend(new KvFs(new MemoryKv()), new MemoryState(), processLocks());
    const faults = [{ method: 'updateRef' as const, error: new HistoryError('unavailable', 'Interrupted.'), times: 1 }];
    const file = doc();
    const { history } = service(() => backendWith(inner, (store) => faulty(store, faults)), () => file, () => 1);
    await history.attach({ kind: 'library', documentId: file.metadata.id });
    await history.flush().catch(() => undefined);
    expect(useEvolutionStore.getState().capture.kind).toBe('failed');
    await history.flush();
    const [meta] = await inner.list();
    const store = (await inner.open(meta!.repoId))!;
    const log = await store.log({ from: [(await store.readRef(MAIN_REF))!], limit: 10 });
    expect(log).toHaveLength(1);
  });

  it('loses no one’s revision when two writers race on one branch', async () => {
    const inner = new BrowserBackend(new KvFs(new MemoryKv()), new MemoryState(), processLocks());
    let fileA = doc();
    const first = service(() => inner, () => fileA, () => 1);
    await first.history.attach({ kind: 'library', documentId: fileA.metadata.id });
    await first.history.flush();
    // A second writer bound to the same branch (two windows on one history: bindings say so directly).
    const [meta] = await inner.list();
    await inner.putBinding({ copyId: 'draft_q_other', repoId: meta!.repoId, altId: null, documentId: fileA.metadata.id, lastSeen: null, at: 1 });
    let fileB = updateNode(fileA, 'n_a', { text: 'From B' });
    const second = service(() => inner, () => fileB, () => 1);
    await second.history.attach({ kind: 'draft', recoveryId: 'q_other' });
    fileA = updateNode(fileA, 'n_a', { text: 'From A' });
    fileB = updateNode(fileB, 'n_a', { y: 90 });
    first.history.noteEdit();
    second.history.noteEdit();
    await Promise.all([first.history.flush(), second.history.flush()]);
    const store = (await inner.open(meta!.repoId))!;
    const log = await store.log({ from: [(await store.readRef(MAIN_REF))!], limit: 10 });
    const texts = await Promise.all(log.map((commit) => store.readSnapshot(commit.oid)));
    expect(texts.some((text) => text.includes('From A'))).toBe(true);
    expect(texts.some((text) => text.includes('From B'))).toBe(true);
  });

  it('reports a damaged revision instead of failing the editor', async () => {
    const inner = new BrowserBackend(new KvFs(new MemoryKv()), new MemoryState(), processLocks());
    const file = doc();
    const { history } = service(() => inner, () => file, () => 1);
    await history.attach({ kind: 'library', documentId: file.metadata.id });
    await history.flush();
    await history.detach({ capture: false });
    const faults = [{ method: 'readSnapshot' as const, error: new HistoryError('corrupt', 'That revision could not be read.'), times: 1 }];
    const again = service(() => backendWith(inner, (store) => faulty(store, faults)), () => file, () => 1);
    await again.history.attach({ kind: 'library', documentId: file.metadata.id });
    await settle();
    expect(useEvolutionStore.getState().capture).toMatchObject({ kind: 'unavailable', message: 'That revision could not be read.' });
  });
});

describe('history never records the wrong thing', () => {
  it('never records another diagram into a closing diagram’s history', async () => {
    const inner = new BrowserBackend(new KvFs(new MemoryKv()), new MemoryState(), processLocks());
    let file = doc();
    const { history } = service(() => inner, () => file, () => 1);
    await history.attach({ kind: 'library', documentId: file.metadata.id });
    await history.flush();
    // Diagram B is already in the editor when A's last capture would run.
    file = addNodes(createDocument('B'), [createNode({ type: 'queue', x: 0, y: 0, id: 'n_b', text: 'B' })]);
    history.noteEdit();
    await history.detach();
    const [meta] = await inner.list();
    const store = (await inner.open(meta!.repoId))!;
    const log = await store.log({ from: [(await store.readRef(MAIN_REF))!], limit: 10 });
    expect(log).toHaveLength(1);
    expect(await store.readSnapshot(log[0]!.oid)).not.toContain('"B"');
  });

  it('records nothing for a copy that is not this device’s to record (a guest’s, a share link’s)', async () => {
    const inner = new BrowserBackend(new KvFs(new MemoryKv()), new MemoryState(), processLocks());
    const file = doc();
    const { history } = service(() => inner, () => file, () => 1, () => false);
    await history.attach({ kind: 'library', documentId: file.metadata.id });
    history.noteEdit();
    await history.flush();
    expect(await inner.list()).toEqual([]);
  });

  it('stays quiet after "pause, then remove": no new history appears on its own', async () => {
    const inner = new BrowserBackend(new KvFs(new MemoryKv()), new MemoryState(), processLocks());
    const file = doc();
    const { history } = service(() => inner, () => file, () => 1);
    await history.attach({ kind: 'library', documentId: file.metadata.id });
    await history.flush();
    await history.setPaused(true);
    await history.removeHistory();
    history.noteEdit();
    await history.flush();
    expect(await inner.list()).toEqual([]);
    expect(useEvolutionStore.getState().capture).toMatchObject({ kind: 'off', reason: 'diagram' });
  });

  it('continues a copy’s history on an alternative of its own', async () => {
    const inner = new BrowserBackend(new KvFs(new MemoryKv()), new MemoryState(), processLocks());
    const file = doc();
    const first = service(() => inner, () => file, () => 1);
    await first.history.attach({ kind: 'library', documentId: file.metadata.id });
    await first.history.flush();
    await first.history.detach({ capture: false });
    const second = service(() => inner, () => file, () => 1);
    await second.history.attach({ kind: 'draft', recoveryId: 'q_copy' });
    await second.history.answerIdentity(true);
    expect(second.history.binding?.altId).toBeTruthy();
    const [meta] = await inner.list();
    expect(meta!.alternatives.map((alt) => alt.name)).toEqual(['Copy: Faults']);
  });
});
