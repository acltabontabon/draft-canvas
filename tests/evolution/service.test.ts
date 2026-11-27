import { beforeEach, describe, expect, it } from 'vitest';
import { createDocument, createNode } from '../../src/document/factory';
import { addNodes, updateNode } from '../../src/document/operations';
import type { DraftDocument } from '../../src/document/types';
import { BrowserBackend, MemoryState } from '../../src/evolution/browser/backend';
import { KvFs, MemoryKv } from '../../src/evolution/browser/kvfs';
import type { Binding } from '../../src/evolution/contracts';
import { copyIdOf } from '../../src/evolution/identity';
import { MAIN_REF } from '../../src/evolution/refs';
import { DEFAULT_SCHEDULE } from '../../src/evolution/scheduler';
import { parseMessage } from '../../src/evolution/trailers';
import { compute } from '../../src/evolution/workerHost';
import { processLocks, type LockRunner } from '../../src/evolution/locks';
import type { ComputeApi } from '../../src/store/evolution/client';
import { INITIAL_EVOLUTION, useEvolutionStore } from '../../src/store/evolution/evolutionStore';
import { HistoryService, type Clock } from '../../src/store/evolution/service';

class ManualClock implements Clock {
  time = 1_700_000_000_000;
  private timers: { at: number; run: () => void; id: number }[] = [];
  private nextId = 1;
  now() {
    return this.time;
  }
  setTimeout(run: () => void, ms: number) {
    const id = this.nextId++;
    this.timers.push({ at: this.time + ms, run, id });
    return id;
  }
  clearTimeout(handle: unknown) {
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  }
  async advance(ms: number) {
    const end = this.time + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.time = next.at;
      next.run();
      await settle(4);
    }
    this.time = end;
    await settle();
  }
}

async function settle(rounds = 50) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function harness(initial: DraftDocument, backend = new BrowserBackend(new KvFs(new MemoryKv()), new MemoryState(), processLocks()), lock?: LockRunner, computing: ComputeApi = compute) {
  let file = initial;
  let generation = 1;
  let gesture = false;
  const clock = new ManualClock();
  const service = new HistoryService({
    backend: () => backend,
    compute: computing,
    editor: { file: () => file, generation: () => generation, atBoundary: () => !gesture },
    clock,
    schedule: () => DEFAULT_SCHEDULE,
    enabled: () => true,
    signature: (at) => ({ name: 'Tester', email: 'tester@draftcanvas.invalid', timestamp: Math.floor(at / 1000), timezoneOffset: 0 }),
    holdCopy: async () => () => {},
    firstUseSeen: () => true,
    ...(lock ? { lock } : {}),
  });
  return {
    service,
    backend,
    clock,
    edit(next: DraftDocument) {
      file = next;
      generation += 1;
      service.noteEdit();
    },
    load(next: DraftDocument) {
      file = next;
      generation += 1;
    },
    set gesture(held: boolean) {
      gesture = held;
    },
    get file() {
      return file;
    },
  };
}

async function revisions(backend: BrowserBackend) {
  const [meta] = await backend.list();
  if (!meta) return [];
  const store = (await backend.open(meta.repoId))!;
  const tip = await store.readRef(MAIN_REF);
  return tip ? store.log({ from: [tip], limit: 100 }) : [];
}

const doc = () => addNodes(createDocument('Payments'), [createNode({ type: 'service', x: 0, y: 0, id: 'n_api', text: 'API Gateway' })]);

beforeEach(() => useEvolutionStore.setState(INITIAL_EVOLUTION));

describe('the history service', { timeout: 30_000 }, () => {
  it('records a new diagram’s first revision after the idle period, with no Git step by the person', async () => {
    const h = harness(doc());
    await h.service.attach({ kind: 'library', documentId: h.file.metadata.id });
    await settle();
    expect(useEvolutionStore.getState().capture.kind).toBe('pending');
    await h.clock.advance(DEFAULT_SCHEDULE.idleMs + 10);
    const log = await revisions(h.backend);
    expect(log).toHaveLength(1);
    expect(parseMessage(log[0]!.message).summary).toBe('Add API Gateway');
    expect(useEvolutionStore.getState().capture.kind).toBe('up-to-date');
  });

  it('records nothing for an edit undone before capture, and records an edit after it', async () => {
    const h = harness(doc());
    await h.service.attach({ kind: 'library', documentId: h.file.metadata.id });
    await h.clock.advance(DEFAULT_SCHEDULE.idleMs + 10);
    const before = h.file;
    h.edit(updateNode(before, 'n_api', { x: 50 }));
    h.edit({ ...before, metadata: { ...before.metadata, updatedAt: before.metadata.updatedAt + 99 } });
    await h.clock.advance(DEFAULT_SCHEDULE.idleMs + 10);
    expect(await revisions(h.backend)).toHaveLength(1);
    h.edit(updateNode(before, 'n_api', { text: 'Gateway' }));
    await h.clock.advance(DEFAULT_SCHEDULE.idleMs + 10);
    const log = await revisions(h.backend);
    expect(log).toHaveLength(2);
    expect(parseMessage(log[0]!.message).summary).toBe('Edit the text of Gateway');
  });

  it('ignores camera moves', async () => {
    const h = harness(doc());
    await h.service.attach({ kind: 'library', documentId: h.file.metadata.id });
    await h.clock.advance(DEFAULT_SCHEDULE.idleMs + 10);
    h.edit({ ...h.file, viewport: { x: 400, y: 10, zoom: 0.5 } });
    await h.clock.advance(DEFAULT_SCHEDULE.idleMs + 10);
    expect(await revisions(h.backend)).toHaveLength(1);
  });

  it('waits for a held gesture to end', async () => {
    const h = harness(doc());
    await h.service.attach({ kind: 'library', documentId: h.file.metadata.id });
    h.gesture = true;
    await h.clock.advance(DEFAULT_SCHEDULE.idleMs + 5_000);
    expect(await revisions(h.backend)).toHaveLength(0);
    h.gesture = false;
    await h.clock.advance(1_000);
    expect(await revisions(h.backend)).toHaveLength(1);
  });

  it('resumes a bound copy after a restart without recording anything new', async () => {
    const h = harness(doc());
    await h.service.attach({ kind: 'library', documentId: h.file.metadata.id });
    await h.clock.advance(DEFAULT_SCHEDULE.idleMs + 10);
    await h.service.detach();
    const again = new HistoryService({ ...(h.service as unknown as { deps: ConstructorParameters<typeof HistoryService>[0] }).deps });
    await again.attach({ kind: 'library', documentId: h.file.metadata.id });
    await settle();
    expect(useEvolutionStore.getState().capture.kind).toBe('up-to-date');
    expect(useEvolutionStore.getState().tip).toBe((await revisions(h.backend))[0]!.oid);
  });

  it('reopens a paused diagram as paused, and records nothing until it is resumed', async () => {
    const h = harness(doc());
    await h.service.attach({ kind: 'library', documentId: h.file.metadata.id });
    await h.clock.advance(DEFAULT_SCHEDULE.idleMs + 10);
    await h.service.setPaused(true);
    h.edit(updateNode(h.file, 'n_api', { text: 'Gateway' }));
    await h.service.detach();
    const again = new HistoryService({ ...(h.service as unknown as { deps: ConstructorParameters<typeof HistoryService>[0] }).deps });
    await again.attach({ kind: 'library', documentId: h.file.metadata.id });
    await settle();
    // It once said the change would be added in a moment, and offered to add it now, which did nothing.
    expect(again.paused).toBe(true);
    expect(useEvolutionStore.getState().capture).toEqual({ kind: 'off', reason: 'diagram' });
    again.requestCapture('manual');
    await h.clock.advance(DEFAULT_SCHEDULE.maxMs + 10);
    expect(await revisions(h.backend)).toHaveLength(1);
    expect(useEvolutionStore.getState().capture).toEqual({ kind: 'off', reason: 'diagram' });
    await again.setPaused(false);
    expect(useEvolutionStore.getState().capture.kind).toBe('pending');
    await h.clock.advance(DEFAULT_SCHEDULE.idleMs + 10);
    expect(await revisions(h.backend)).toHaveLength(2);
  });

  it('honours a pause an earlier version kept in repo.json, and lifts it on resume', async () => {
    const h = harness(doc());
    const key = { kind: 'library' as const, documentId: h.file.metadata.id };
    await h.service.attach(key);
    await h.clock.advance(DEFAULT_SCHEDULE.idleMs + 10);
    const store = h.service.store!;
    await store.writeMeta({ ...(await store.meta()), paused: true });
    await h.service.detach();
    await h.service.attach(key);
    expect(h.service.paused).toBe(true);
    await h.service.setPaused(false);
    expect(h.service.paused).toBe(false);
    expect((await store.meta()).paused).toBeUndefined();
    expect((await h.backend.binding(copyIdOf(key)))?.paused).toBeUndefined();
  });

  it('keeps a pause on disk when a capture finishes while the pause is being written', async () => {
    // The history worker stores a write as it arrives and answers it later. A pause is held there,
    // stored but unanswered, while the capture under way finishes and writes the binding too.
    const inner = new BrowserBackend(new KvFs(new MemoryKv()), new MemoryState(), processLocks());
    let holdPause = false;
    let answerPause = () => {};
    const backend = new Proxy(inner, {
      get(target, prop) {
        if (prop === 'putBinding') {
          return async (binding: Binding) => {
            await target.putBinding(binding);
            if (!holdPause || !binding.paused) return;
            holdPause = false;
            await new Promise<void>((resolve) => (answerPause = resolve));
          };
        }
        const value: unknown = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    let holdCapture = false;
    let resumeCapture = () => {};
    const h = harness(doc(), backend, undefined, {
      ...compute,
      describe: async (...args) => {
        if (holdCapture) await new Promise<void>((resolve) => (resumeCapture = resolve));
        return compute.describe(...args);
      },
    });
    const key = { kind: 'library' as const, documentId: h.file.metadata.id };
    await h.service.attach(key);
    await h.clock.advance(DEFAULT_SCHEDULE.idleMs + 10);

    h.edit(updateNode(h.file, 'n_api', { text: 'Gateway' }));
    holdCapture = true;
    holdPause = true;
    const capturing = h.service.flush();
    await settle();
    const pausing = h.service.setPaused(true);
    await settle();
    resumeCapture();
    await settle();
    answerPause();
    await Promise.all([capturing, pausing]);

    // It once said paused while the binding stored last, the capture's, had no pause in it.
    const stored = await inner.binding(copyIdOf(key));
    expect(h.service.paused).toBe(true);
    expect(stored?.paused).toBe(true);
    expect(stored?.lastSeen).toBe(await h.service.store!.readRef(MAIN_REF));
    await h.service.detach();
    await h.service.attach(key);
    expect(h.service.paused).toBe(true);
  });

  it('keeps a pause made while the diagram moves to another alternative, whichever is stored first', async () => {
    const h = harness(doc());
    const key = { kind: 'library' as const, documentId: h.file.metadata.id };
    await h.service.attach(key);
    await h.clock.advance(DEFAULT_SCHEDULE.idleMs + 10);
    // What a switch writes, built from the binding it read as it began.
    const begun = h.service.context()!;
    const moved = { ...begun.binding!, altId: 'a_next', lastSeen: begun.tip, at: 1 };

    // Paused after the switch read the binding, before it wrote its own.
    await h.service.setPaused(true);
    await h.service.putBindingFor(moved);
    await h.service.adopt(begun.token, { tip: begun.tip, binding: moved });
    expect(await h.backend.binding(copyIdOf(key))).toMatchObject({ altId: 'a_next', paused: true });
    expect(h.service.binding).toMatchObject({ altId: 'a_next', paused: true });

    // Resumed after the switch back wrote its binding, before it was done: the resume once wrote the
    // binding as the session still had it, on the alternative the switch had just left.
    const back = h.service.context()!;
    const main = { ...back.binding!, altId: null };
    await h.service.putBindingFor(main);
    await h.service.setPaused(false);
    await h.service.adopt(back.token, { tip: back.tip, binding: main });
    const stored = await h.backend.binding(copyIdOf(key));
    expect(stored?.altId).toBeNull();
    expect(stored?.paused).toBeUndefined();
    expect(h.service.binding?.paused).toBeUndefined();
  });

  it('finishes a capture into the history it began with when another diagram opens meanwhile', async () => {
    const h = harness(doc());
    await h.service.attach({ kind: 'library', documentId: h.file.metadata.id });
    h.service.requestCapture('manual');
    // Open another diagram while the first capture is still running.
    const other = createDocument('Other');
    h.load(other);
    await h.service.attach({ kind: 'library', documentId: other.metadata.id });
    await settle();
    const metas = await h.backend.list();
    expect(metas.map((meta) => meta.title)).toEqual(['Payments']);
    expect(useEvolutionStore.getState().copyId).toBe(`lib_${other.metadata.id}`);
  });

  describe('a history two copies continue', () => {
    const ORIGINAL = { kind: 'file' as const, path: '/work/payments.draftcanvas' };
    const COPY = { kind: 'file' as const, path: '/work/payments-v2.draftcanvas' };

    /** The original records two revisions; a Save As copy then continues its history. */
    async function shared() {
      const one = harness(doc());
      await one.service.attach(ORIGINAL);
      await one.clock.advance(DEFAULT_SCHEDULE.idleMs + 10);
      one.edit(updateNode(one.file, 'n_api', { text: 'Gateway' }));
      await one.clock.advance(DEFAULT_SCHEDULE.idleMs + 10);
      const repoId = one.service.store!.repoId;
      const main = (await one.service.store!.readRef(MAIN_REF))!;
      await one.service.detach();
      const two = harness(one.file, one.backend);
      await two.service.attach(COPY);
      await two.service.answerIdentity(true);
      expect(two.service.binding).toMatchObject({ repoId });
      return { one, two, repoId, main };
    }

    it('pauses one copy without pausing the other', async () => {
      const { one, two, main } = await shared();
      await two.service.setPaused(true);
      await two.service.detach();
      // Pausing lived in the history's repo.json, so pausing the copy paused the original too.
      await one.service.attach(ORIGINAL);
      expect(one.service.paused).toBe(false);
      one.edit(updateNode(one.file, 'n_api', { text: 'Edge' }));
      await one.clock.advance(DEFAULT_SCHEDULE.idleMs + 10);
      expect(await one.service.store!.readRef(MAIN_REF)).not.toBe(main);
      await one.service.detach();
      await two.service.attach(COPY);
      expect(two.service.paused).toBe(true);
      expect(useEvolutionStore.getState().capture).toEqual({ kind: 'off', reason: 'diagram' });
    });

    it('removing it from one copy keeps it whole for the other', async () => {
      const { one, two, repoId, main } = await shared();
      expect(await two.service.sharedWith()).toBe(1);
      // This once deleted the original's revisions, alternatives and milestones, and its binding.
      await two.service.removeHistory();
      expect(await one.backend.binding(copyIdOf(COPY))).toBeUndefined();
      expect(await one.backend.binding(copyIdOf(ORIGINAL))).toMatchObject({ repoId });
      expect(await (await one.backend.open(repoId))!.readRef(MAIN_REF)).toBe(main);
      expect(useEvolutionStore.getState().capture).toEqual({ kind: 'empty' });
      // The copy's next change starts a history of its own.
      two.edit(updateNode(two.file, 'n_api', { text: 'Copy' }));
      await two.clock.advance(DEFAULT_SCHEDULE.idleMs + 10);
      expect(two.service.store!.repoId).not.toBe(repoId);
      await two.service.detach();
      await one.service.attach(ORIGINAL);
      expect(one.service.store!.repoId).toBe(repoId);
      expect(useEvolutionStore.getState().tip).toBe(main);
    });

    it('changes repo.json from what it holds now, not from what a session read earlier', async () => {
      const one = harness(doc());
      await one.service.attach(ORIGINAL);
      await one.clock.advance(DEFAULT_SCHEDULE.idleMs + 10);
      const repoId = one.service.store!.repoId;
      // Another window opens the copy while this one still has the original open.
      const two = harness(one.file, one.backend);
      await two.service.attach(COPY);
      await two.service.answerIdentity(true);
      // This session read repo.json before the copy added its alternative. Writing that back (a
      // publishing setting) once dropped the alternative from the switcher and from publishing.
      await one.service.updateMeta((meta) => ({ ...meta, remote: { url: 'https://example.com/a.git', policy: 'manual', publishAlternatives: [] } }));
      const meta = await (await one.backend.open(repoId))!.meta();
      expect(meta.alternatives.map((alt) => alt.name)).toEqual(['Copy: Payments']);
      expect(meta.remote?.url).toBe('https://example.com/a.git');
    });

    it('lets two windows change repo.json at once without either change being lost', async () => {
      const lock = processLocks();
      const one = harness(doc(), undefined, lock);
      await one.service.attach(ORIGINAL);
      await one.clock.advance(DEFAULT_SCHEDULE.idleMs + 10);
      const repoId = one.service.store!.repoId;
      const two = harness(one.file, one.backend, lock);
      await two.service.attach(COPY);
      await two.service.answerIdentity(true);
      await Promise.all([
        one.service.updateMeta((meta) => ({ ...meta, remote: { url: 'https://example.com/a.git', policy: 'manual', publishAlternatives: [] } })),
        two.service.updateMeta((meta) => ({ ...meta, alternatives: meta.alternatives.map((alt) => ({ ...alt, name: 'Payments v2' })) })),
      ]);
      const meta = await (await one.backend.open(repoId))!.meta();
      expect(meta.alternatives.map((alt) => alt.name)).toEqual(['Payments v2']);
      expect(meta.remote?.url).toBe('https://example.com/a.git');
    });

    it('removes it for every copy only when asked to', async () => {
      const { one, two, repoId } = await shared();
      await two.service.removeHistory({ everywhere: true });
      expect(await one.backend.open(repoId)).toBeUndefined();
      expect(await one.backend.binding(copyIdOf(ORIGINAL))).toBeUndefined();
    });
  });

  it('asks before continuing another copy’s history, and starts fresh when told to', async () => {
    const h = harness(doc());
    await h.service.attach({ kind: 'library', documentId: h.file.metadata.id });
    await h.clock.advance(DEFAULT_SCHEDULE.idleMs + 10);
    // The same file opened as another working copy (a duplicate made outside the app).
    await h.service.attach({ kind: 'draft', recoveryId: 'q_copy' });
    await settle();
    expect(useEvolutionStore.getState().capture).toMatchObject({ kind: 'identity', relation: 'copy', title: 'Payments' });
    h.edit(updateNode(h.file, 'n_api', { x: 9 }));
    await h.clock.advance(DEFAULT_SCHEDULE.idleMs + 10);
    expect(await h.backend.list()).toHaveLength(1);
    await h.service.answerIdentity(false);
    await h.clock.advance(DEFAULT_SCHEDULE.idleMs + 10);
    expect(await h.backend.list()).toHaveLength(2);
  });
});
