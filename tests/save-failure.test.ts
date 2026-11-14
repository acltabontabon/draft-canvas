/**
 * A save that fails says why, and leaves a way out; a camera move is the cheapest thing there is to
 * lose and is written like it; and a stored diagram a newer Draft Canvas wrote is named, not "unreadable".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createDocument, createNode } from '../src/document/factory';
import { addNodes } from '../src/document/operations';
import { CURRENT_VERSION, type DraftDocument } from '../src/document/types';
import { IndexedDbRepository } from '../src/storage/IndexedDbRepository';
import { MemoryRepository } from '../src/storage/MemoryRepository';
import { Autosave, type SaveState } from '../src/storage/autosave';
import { QuotaExceededError, StorageUnavailableError } from '../src/storage/DraftRepository';
import { saveFailureMessage, saveFailureOf, storageFailureNotice } from '../src/storage/saveFailure';
import { __resetKeyCacheForTests } from '../src/crypto/keyStore';

const documentWith = (title: string): DraftDocument =>
  addNodes(createDocument(title), [createNode({ type: 'service', x: 0, y: 0, text: 'API' })]);
const moved = (doc: DraftDocument, x: number): DraftDocument => ({ ...doc, viewport: { x, y: 0, zoom: 1 } });
const edited = (doc: DraftDocument): DraftDocument => addNodes(doc, [createNode({ type: 'note', x: 0, y: 400 })]);

/** Fails with whatever it is told to, until it is told to stop. */
class FlakyRepository extends MemoryRepository {
  failWith: unknown = null;
  readonly writes: Array<{ at: number; cameraOnly: boolean }> = [];

  async save(document: DraftDocument, base?: Parameters<MemoryRepository['save']>[1], options?: Parameters<MemoryRepository['save']>[2]) {
    if (this.failWith) throw this.failWith;
    this.writes.push({ at: Date.now(), cameraOnly: options?.cameraOnly === true });
    return super.save(document, base, options);
  }
}

describe('why a save failed', () => {
  it.each([
    ['the browser is out of room', new QuotaExceededError(), 'full'],
    ['a quota DOMException', new DOMException('full', 'QuotaExceededError'), 'full'],
    ['the connection to storage was closed', new DOMException('The database connection is closing.', 'InvalidStateError'), 'closed'],
    ['storage was never available', new StorageUnavailableError(), 'closed'],
    ['anything else', new Error('boom'), 'other'],
    ['a document the browser cannot clone', new DOMException('could not be cloned', 'DataCloneError'), 'other'],
  ] as const)('reads %s as "%s"', (_label, error, failure) => {
    expect(saveFailureOf(error)).toBe(failure);
  });

  it('says what to do, in words that work from inside the diagram', () => {
    expect(saveFailureMessage('full')).toMatch(/Export it, then free space by deleting diagrams in the Library/);
    expect(saveFailureMessage('closed')).toMatch(/Export it, then reload/);
    expect(saveFailureMessage('other')).toMatch(/Retry, or export it/);
    // Never the old guess that covered every cause at once.
    for (const failure of ['full', 'closed', 'other'] as const) expect(saveFailureMessage(failure)).not.toMatch(/may be full or unavailable/);
    expect(storageFailureNotice('rename that diagram', new QuotaExceededError())).toMatch(/^Couldn’t rename that diagram\. This browser is out of storage space/);
    expect(storageFailureNotice('rename that diagram', new Error('x'))).not.toMatch(/may be full or unavailable/);
  });

  it('shows the reason in the state, and takes it away when a save lands', async () => {
    const repository = new FlakyRepository();
    const states: SaveState[] = [];
    const autosave = new Autosave({ repository, onStateChange: (state) => states.push({ ...state }), debounceMs: 0, maxWaitMs: 0 });
    const doc = documentWith('Reasons');
    autosave.track(doc);

    repository.failWith = new QuotaExceededError();
    autosave.schedule(edited(doc));
    expect(await autosave.flush()).toBe(false);
    expect(states.at(-1)).toMatchObject({ status: 'error', failure: 'full', message: saveFailureMessage('full') });

    repository.failWith = new DOMException('The database connection is closing.', 'InvalidStateError');
    expect(await autosave.flush()).toBe(false);
    expect(states.at(-1)).toMatchObject({ status: 'error', failure: 'closed' });

    repository.failWith = new Error('boom');
    expect(await autosave.flush()).toBe(false);
    expect(states.at(-1)).toMatchObject({ status: 'error', failure: 'other' });

    // Retry: the same version is still queued, and lands.
    repository.failWith = null;
    expect(await autosave.flush()).toBe(true);
    expect(states.at(-1)?.status).toBe('saved');
    expect(states.at(-1)?.failure).toBeUndefined();
    expect(states.at(-1)?.message).toBeUndefined();
    expect(repository.writes).toHaveLength(1);
    autosave.dispose();
  });

  it('lets go of what could not be stored when the person leaves without saving', async () => {
    const repository = new FlakyRepository();
    const states: SaveState[] = [];
    const autosave = new Autosave({ repository, onStateChange: (state) => states.push({ ...state }), debounceMs: 0, maxWaitMs: 0 });
    const doc = documentWith('Leaving');
    autosave.track(doc);
    repository.failWith = new Error('boom');
    autosave.schedule(edited(doc));
    expect(await autosave.flush()).toBe(false);
    expect(autosave.hasPendingWork).toBe(true);
    expect(autosave.unsavedForStash()).toHaveLength(1);

    autosave.discardPending(doc.metadata.id);
    expect(autosave.hasPendingWork).toBe(false);
    expect(autosave.unsavedForStash()).toEqual([]);
    expect(states.at(-1)).toMatchObject({ status: 'idle', failure: undefined, message: undefined });
    // Closing the diagram is no longer refused.
    repository.failWith = null;
    expect(await autosave.flush()).toBe(true);
    expect(repository.writes).toHaveLength(0);
    autosave.dispose();
  });

  it('keeps another diagram’s pending write when one is given up', async () => {
    const repository = new FlakyRepository();
    const autosave = new Autosave({ repository, onStateChange: () => {}, debounceMs: 0, maxWaitMs: 0 });
    const a = documentWith('A');
    const b = documentWith('B');
    autosave.track(a);
    autosave.track(b);
    repository.failWith = new Error('boom');
    autosave.schedule(edited(a));
    autosave.schedule(edited(b));
    await autosave.flush();
    autosave.discardPending(a.metadata.id);
    repository.failWith = null;
    expect(await autosave.flush()).toBe(true);
    expect(repository.writes).toHaveLength(1);
    expect((await repository.load(b.metadata.id))?.nodes).toHaveLength(2);
    expect(await repository.load(a.metadata.id)).toBeNull();
    autosave.dispose();
  });
});

describe('a camera move is written when the person stops looking around', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const setup = () => {
    const repository = new FlakyRepository();
    const states: string[] = [];
    const autosave = new Autosave({ repository, onStateChange: (state) => states.push(state.status) });
    const doc = documentWith('Camera');
    autosave.track(doc);
    return { repository, autosave, doc, states };
  };

  it('writes once, about 3.5 s after the last move — not 0.7 s', async () => {
    const { repository, autosave, doc } = setup();
    autosave.schedule(moved(doc, -10), { cameraOnly: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(repository.writes).toHaveLength(0);
    autosave.schedule(moved(doc, -20), { cameraOnly: true });
    await vi.advanceTimersByTimeAsync(3400);
    expect(repository.writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(repository.writes).toEqual([{ at: expect.any(Number), cameraOnly: true }]);
    autosave.dispose();
  });

  it('rewrites the body only about every 10 s of continuous panning, not every 4 s', async () => {
    const { repository, autosave, doc } = setup();
    for (let tick = 0; tick < 300; tick += 1) {
      autosave.schedule(moved(doc, -tick), { cameraOnly: true });
      await vi.advanceTimersByTimeAsync(100);
    }
    // Thirty seconds of panning: the old 4 s ceiling wrote seven times.
    expect(repository.writes.length).toBeGreaterThanOrEqual(2);
    expect(repository.writes.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < repository.writes.length; i += 1) {
      expect(repository.writes[i]!.at - repository.writes[i - 1]!.at).toBeGreaterThanOrEqual(9_000);
    }
    await vi.advanceTimersByTimeAsync(4000);
    expect(repository.writes.at(-1)).toMatchObject({ cameraOnly: true });
    autosave.dispose();
  });

  it('is not reported as unsaved work, and does not flicker the bar', async () => {
    const { autosave, doc, states } = setup();
    autosave.schedule(moved(doc, -10), { cameraOnly: true });
    await vi.advanceTimersByTimeAsync(5000);
    expect(states).not.toContain('dirty');
    expect(states).not.toContain('saving');
    autosave.dispose();
  });

  it('still flushes at once when the page is leaving', async () => {
    const { repository, autosave, doc } = setup();
    autosave.schedule(moved(doc, -10), { cameraOnly: true });
    expect(await autosave.flush()).toBe(true);
    expect(repository.writes).toHaveLength(1);
    autosave.dispose();
  });

  it('gives the first real edit after a long pan its ordinary clock, not an immediate write', async () => {
    const { repository, autosave, doc } = setup();
    for (let tick = 0; tick < 80; tick += 1) {
      autosave.schedule(moved(doc, -tick), { cameraOnly: true });
      await vi.advanceTimersByTimeAsync(100);
    }
    const before = repository.writes.length;
    autosave.schedule(edited(moved(doc, -80)));
    await vi.advanceTimersByTimeAsync(300);
    expect(repository.writes).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(500);
    expect(repository.writes).toHaveLength(before + 1);
    expect(repository.writes.at(-1)).toMatchObject({ cameraOnly: false });
    autosave.dispose();
  });

  it('leaves a failed save for its Retry: panning does not retry the whole body on every move', async () => {
    const { repository, autosave, doc, states } = setup();
    repository.failWith = new Error('boom');
    autosave.schedule(edited(doc));
    await vi.advanceTimersByTimeAsync(1000);
    expect(states.at(-1)).toBe('error');
    repository.failWith = null;
    for (let tick = 0; tick < 100; tick += 1) {
      autosave.schedule(moved(edited(doc), -tick), { cameraOnly: true });
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(repository.writes).toHaveLength(0);
    expect(states.at(-1)).toBe('error');
    // The explicit retry writes the content and the camera it was left looking at.
    expect(await autosave.flush()).toBe(true);
    expect(repository.writes).toEqual([{ at: expect.any(Number), cameraOnly: false }]);
    autosave.dispose();
  });
});

describe('a diagram a newer Draft Canvas saved', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    __resetKeyCacheForTests();
  });

  const putRow = (row: { id: string } & Record<string, unknown>) =>
    new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('draft-canvas');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const tx = request.result.transaction('bodies', 'readwrite');
        tx.objectStore('bodies').put(row);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      };
    });

  it('is named as newer, once, and left exactly as it was', async () => {
    const repository = await IndexedDbRepository.open();
    const doc = documentWith('From the future');
    await repository.save(doc);
    const row = { id: doc.metadata.id, storageVersion: 2, stamp: 'b_future', document: { ...JSON.parse(JSON.stringify(doc)), format: 'draft-canvas', version: CURRENT_VERSION + 1 } };
    await putRow(row);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await repository.load(doc.metadata.id)).toBeNull();
    expect(repository.takeLoadFailure(doc.metadata.id)).toBe('newer');
    // Handed over once.
    expect(repository.takeLoadFailure(doc.metadata.id)).toBeUndefined();
    warn.mockRestore();
    // Untouched, and still listed (the Library does not hide what it cannot open).
    expect(await repository.has(doc.metadata.id)).toBe(true);
    expect((await repository.list()).map((entry) => entry.id)).toContain(doc.metadata.id);
  });

  it('is told apart from one that is damaged, and from one that opens fine', async () => {
    const repository = await IndexedDbRepository.open();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await putRow({ id: 'damaged', storageVersion: 2, stamp: 'b', document: { format: 'something-else' } });
    expect(await repository.load('damaged')).toBeNull();
    expect(repository.takeLoadFailure('damaged')).toBe('unreadable');
    warn.mockRestore();

    const fine = documentWith('Fine');
    await repository.save(fine);
    expect((await repository.load(fine.metadata.id))?.metadata.title).toBe('Fine');
    expect(repository.takeLoadFailure(fine.metadata.id)).toBeUndefined();
    // Missing is not a failure to read.
    expect(await repository.load('missing')).toBeNull();
    expect(repository.takeLoadFailure('missing')).toBeUndefined();
  });
});
