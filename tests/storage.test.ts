import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { cloneDocumentAsNew, createDocument, createNode } from '../src/document/factory';
import { addNodes } from '../src/document/operations';
import { IndexedDbRepository } from '../src/storage/IndexedDbRepository';
import { MemoryRepository } from '../src/storage/MemoryRepository';
import { Autosave } from '../src/storage/autosave';
import { QuotaExceededError } from '../src/storage/DraftRepository';
import { decryptDocument } from '../src/crypto/documentCipher';
import * as documentCipher from '../src/crypto/documentCipher';
import { getOrCreateMasterKey, __resetKeyCacheForTests } from '../src/crypto/keyStore';
import { isEncryptedBody } from '../src/crypto/migrateStorage';
import type { EncryptedBody } from '../src/crypto/types';
import { CURRENT_VERSION, type DraftDocument } from '../src/document/types';

function documentWith(title: string, nodeCount = 2): DraftDocument {
  const nodes = Array.from({ length: nodeCount }, (_, index) =>
    createNode({ type: 'service', x: index * 200, y: 0, text: `Service ${index}` }),
  );
  return addNodes(createDocument(title), nodes);
}

/**
 * Writes the plaintext `{ id, document }` shape every `bodies` row had
 * before encryption existed, bypassing `IndexedDbRepository.save()` (which
 * always encrypts now) — this is the only way left to simulate a record
 * genuinely written by a build before this phase, since nothing in the
 * current app can produce that shape anymore.
 */
function writeLegacyPlaintextRow(document: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('draft-canvas');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const tx = req.result.transaction('bodies', 'readwrite');
      tx.objectStore('bodies').put({ id: (document as DraftDocument).metadata.id, document });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
  });
}

/** Reads a raw `bodies` row back, bypassing `load()`'s own decrypt/migrate. */
function readRawRow(id: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('draft-canvas');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const tx = req.result.transaction('bodies', 'readonly');
      const getReq = tx.objectStore('bodies').get(id);
      getReq.onsuccess = () => resolve(getReq.result);
      getReq.onerror = () => reject(getReq.error);
    };
  });
}

beforeEach(() => {
  // A fresh database per test, so ordering assertions cannot leak between them.
  globalThis.indexedDB = new IDBFactory();
  // The key store caches its db connection and the key itself at module
  // scope — both must be reset alongside `indexedDB` or a later test would
  // silently reuse a key tied to an IDBFactory instance no test can see anymore.
  __resetKeyCacheForTests();
});

describe('local persistence', () => {
  it('saves and restores a document across a fresh connection', async () => {
    const repository = await IndexedDbRepository.open();
    const doc = documentWith('Payment Flow', 3);
    await repository.save(doc);

    // A second open stands in for reloading the page.
    const reopened = await IndexedDbRepository.open();
    const loaded = await reopened.load(doc.metadata.id);

    expect(loaded).not.toBeNull();
    expect(loaded!.metadata.title).toBe('Payment Flow');
    expect(loaded!.nodes).toHaveLength(3);
    expect(loaded!.nodes[0]!.text).toBe('Service 0');
  });

  it('lists documents most recently edited first, without loading their contents', async () => {
    const repository = await IndexedDbRepository.open();
    await repository.save({
      ...documentWith('Older'),
      metadata: { ...documentWith('Older').metadata, updatedAt: 1000 },
    });
    await repository.save({
      ...documentWith('Newer'),
      metadata: { ...documentWith('Newer').metadata, updatedAt: 2000 },
    });

    const list = await repository.list();
    expect(list.map((entry) => entry.title)).toEqual(['Newer', 'Older']);
    expect(list[0]!.nodeCount).toBe(2);
    // The listing is metadata only — no canvas contents come back with it.
    expect(list[0]).not.toHaveProperty('nodes');
  });

  it('deletes a document and its contents together', async () => {
    const repository = await IndexedDbRepository.open();
    const doc = documentWith('Temporary');
    await repository.save(doc);
    await repository.remove(doc.metadata.id);

    expect(await repository.load(doc.metadata.id)).toBeNull();
    expect(await repository.list()).toHaveLength(0);
  });

  it('renames without disturbing the canvas', async () => {
    const repository = await IndexedDbRepository.open();
    const doc = documentWith('Before', 4);
    await repository.save(doc);
    await repository.rename(doc.metadata.id, 'After');

    const loaded = await repository.load(doc.metadata.id);
    expect(loaded!.metadata.title).toBe('After');
    expect(loaded!.nodes).toHaveLength(4);
  });

  /** Runs `during` once, right after `rename()` has read the body and before it writes. */
  function raceAfterRead(repository: IndexedDbRepository, during: (loaded: DraftDocument) => Promise<void>) {
    type Readable = { readBody(id: string): Promise<{ document: DraftDocument } | null> };
    const target = repository as unknown as Readable;
    const realRead = target.readBody.bind(repository);
    let raced = false;
    vi.spyOn(target, 'readBody').mockImplementation(async (id) => {
      const read = await realRead(id);
      if (!raced && read) {
        raced = true;
        await during(read.document);
      }
      return read;
    });
  }

  it('a rename never overwrites edits another tab saved while it was decrypting', async () => {
    const repository = await IndexedDbRepository.open();
    const otherTab = await IndexedDbRepository.open();
    const doc = documentWith('Before', 2);
    await repository.save(doc);

    raceAfterRead(repository, async (loaded) => {
      const edited = addNodes(loaded, [createNode({ type: 'service', x: 999, y: 0 })]);
      await otherTab.save({ ...edited, metadata: { ...edited.metadata, updatedAt: Date.now() + 1 } });
    });

    await repository.rename(doc.metadata.id, 'After');
    vi.restoreAllMocks();

    const loaded = await otherTab.load(doc.metadata.id);
    expect(loaded!.metadata.title).toBe('After');
    expect(loaded!.nodes).toHaveLength(3);
  });

  it('a rename never overwrites a viewport-only save that kept the same updatedAt', async () => {
    const repository = await IndexedDbRepository.open();
    const otherTab = await IndexedDbRepository.open();
    const doc = documentWith('Before', 2);
    await repository.save(doc);

    raceAfterRead(repository, async (loaded) => {
      await otherTab.save({ ...loaded, viewport: { x: 321, y: 123, zoom: 1.5 } });
    });

    await repository.rename(doc.metadata.id, 'After');
    vi.restoreAllMocks();

    const loaded = await otherTab.load(doc.metadata.id);
    expect(loaded!.metadata.title).toBe('After');
    expect(loaded!.viewport).toEqual({ x: 321, y: 123, zoom: 1.5 });
  });

  it('closes its connection and tells listeners when a newer version needs the database', async () => {
    const { onStorageSuperseded } = await import('../src/storage/IndexedDbRepository');
    await IndexedDbRepository.open();
    const listener = vi.fn();
    const stop = onStorageSuperseded(listener);

    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('draft-canvas', 99);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    stop();
    upgraded.close();
    expect(listener).toHaveBeenCalledOnce();
  });

  it('duplicates into an independent document', async () => {
    const repository = await IndexedDbRepository.open();
    const original = documentWith('Original', 2);
    await repository.save(original);
    await repository.save(cloneDocumentAsNew(original, 'Original copy'));

    const list = await repository.list();
    expect(list).toHaveLength(2);
    expect(new Set(list.map((entry) => entry.id)).size).toBe(2);
  });

  it('repairs a corrupted record rather than failing to open it', async () => {
    const repository = await IndexedDbRepository.open();
    const doc = documentWith('Damaged');
    await repository.save({
      ...doc,
      edges: [{ id: 'e', source: 'ghost', target: 'phantom' }] as never,
    });

    const loaded = await repository.load(doc.metadata.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.edges).toHaveLength(0);
    expect(loaded!.nodes).toHaveLength(2);
  });

  it('migrates a record left in an older format by a previous build of the app', async () => {
    const repository = await IndexedDbRepository.open();
    const doc = documentWith('From an older build', 2);
    const [a, b] = doc.nodes;
    // Simulates a record actually written by pre-anchor, pre-encryption
    // code: plaintext, version 2, no sourceAnchor/targetAnchor at all.
    await writeLegacyPlaintextRow({
      ...doc,
      version: 2,
      edges: [{ id: 'e1', source: a!.id, target: b!.id, directed: true, routing: 'smoothstep' }],
    });

    const loaded = await repository.load(doc.metadata.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.version).toBe(CURRENT_VERSION);
    expect(loaded!.edges[0]!.sourceAnchor).toBeDefined();
    expect(loaded!.edges[0]!.targetAnchor).toBeDefined();
  });

  it('persists the migrated record — both schema and encryption — so neither is silently redone every load', async () => {
    const repository = await IndexedDbRepository.open();
    const doc = documentWith('Migrate once', 2);
    const [a, b] = doc.nodes;
    await writeLegacyPlaintextRow({
      ...doc,
      version: 2,
      edges: [{ id: 'e1', source: a!.id, target: b!.id, directed: true, routing: 'smoothstep' }],
    });

    await repository.load(doc.metadata.id);

    // A second `load()` call would recompute the same migration in memory
    // either way, so it can't distinguish "persisted" from "re-derived every
    // time" — read the raw stored bytes directly instead, bypassing `load`'s
    // own decrypt/migrate, to confirm the record on disk was actually rewritten.
    const raw = await readRawRow(doc.metadata.id);
    expect(isEncryptedBody(raw)).toBe(true);

    const key = await getOrCreateMasterKey();
    const decrypted = await decryptDocument(raw as EncryptedBody, key);
    expect((decrypted as { version: number }).version).toBe(CURRENT_VERSION);
  });

  it('load() resolves null rather than rejecting when the raw record cannot be read', async () => {
    const repository = await IndexedDbRepository.open();
    const doc = documentWith('Unreadable row', 2);
    await repository.save(doc);

    const dbField = (repository as unknown as { db: { get: (...args: unknown[]) => unknown } }).db;
    vi.spyOn(dbField, 'get').mockRejectedValueOnce(new Error('simulated IndexedDB read failure'));

    await expect(repository.load(doc.metadata.id)).resolves.toBeNull();
  });

  it('a failed self-verification during a migration resave leaves the original record on disk untouched, but load() still returns the migrated document', async () => {
    const repository = await IndexedDbRepository.open();
    const doc = documentWith('Verify failure', 2);
    const [a, b] = doc.nodes;
    await writeLegacyPlaintextRow({
      ...doc,
      version: 2,
      edges: [{ id: 'e1', source: a!.id, target: b!.id, directed: true, routing: 'smoothstep' }],
    });

    // The only `decryptDocument` call this scenario reaches is `saveVerified`'s
    // own internal verify step — the legacy row itself is plaintext, so
    // `load()` never decrypts to read it.
    const spy = vi.spyOn(documentCipher, 'decryptDocument').mockResolvedValueOnce(null);

    const loaded = await repository.load(doc.metadata.id);
    // The caller still gets the correctly migrated in-memory document even
    // though persisting it failed self-verification.
    expect(loaded).not.toBeNull();
    expect(loaded!.version).toBe(CURRENT_VERSION);
    expect(loaded!.edges[0]!.sourceAnchor).toBeDefined();

    // The original row on disk was never overwritten — reading it back
    // directly still finds the original legacy plaintext shape, not a
    // partially-written or corrupted encrypted one.
    const raw = await readRawRow(doc.metadata.id);
    expect(isEncryptedBody(raw)).toBe(false);

    spy.mockRestore();
  });

  it('returns null for a record too broken to recognise', async () => {
    const repository = await IndexedDbRepository.open();
    await repository.save(documentWith('Fine'));
    const list = await repository.list();
    expect(await repository.load(`${list[0]!.id}-does-not-exist`)).toBeNull();
  });

  it('falls back to memory without losing the in-flight document', async () => {
    const repository = new MemoryRepository();
    const doc = documentWith('Ephemeral');
    await repository.save(doc);
    expect((await repository.load(doc.metadata.id))!.metadata.title).toBe('Ephemeral');
    expect(repository.durable).toBe(false);
  });
});

/** Phase 5.1 — one background image blob per document, in its own store. */
describe.each([
  ['IndexedDbRepository', () => IndexedDbRepository.open()],
  ['MemoryRepository', () => Promise.resolve(new MemoryRepository())],
])('background image storage (%s)', (_name, open) => {
  it("removing or pruning a document never touches another document's images whose id extends it with #", async () => {
    const repository = await open();
    const dims = { width: 10, height: 10 };
    const image = () => new Blob(['x'], { type: 'image/png' });
    await repository.saveBackgroundImage('d_x', image(), dims, 'bg_a');
    await repository.saveBackgroundImage('d_x#1', image(), dims, 'bg_b');

    await repository.pruneBackgroundImages('d_x', null);
    expect(await repository.loadBackgroundImage('d_x', 'bg_a')).toBeNull();
    expect(await repository.loadBackgroundImage('d_x#1', 'bg_b')).not.toBeNull();

    await repository.saveBackgroundImage('d_x', image(), dims, 'bg_c');
    await repository.remove('d_x');
    expect(await repository.loadBackgroundImage('d_x', 'bg_c')).toBeNull();
    expect(await repository.loadBackgroundImage('d_x#1', 'bg_b')).not.toBeNull();
  });

  it('round-trips a saved image', async () => {
    const repository = await open();
    const doc = documentWith('With background');
    await repository.save(doc);
    const blob = new Blob(['fake-image-bytes'], { type: 'image/png' });

    await repository.saveBackgroundImage(doc.metadata.id, blob, { width: 200, height: 100 });
    const loaded = await repository.loadBackgroundImage(doc.metadata.id);

    expect(loaded).not.toBeNull();
    expect(loaded!.width).toBe(200);
    expect(loaded!.height).toBe(100);
    expect(loaded!.blob.type).toBe('image/png');
  });

  it('keeps each chosen image under its own id, and prunes all but the one showing', async () => {
    const repository = await open();
    const doc = documentWith('Replaced background');
    await repository.save(doc);
    await repository.saveBackgroundImage(doc.metadata.id, new Blob(['legacy']), { width: 1, height: 1 });
    await repository.saveBackgroundImage(doc.metadata.id, new Blob(['first']), { width: 2, height: 2 }, 'bg_a');
    await repository.saveBackgroundImage(doc.metadata.id, new Blob(['second']), { width: 3, height: 3 }, 'bg_b');
    const other = documentWith('Untouched');
    await repository.saveBackgroundImage(other.metadata.id, new Blob(['other']), { width: 4, height: 4 });

    // Undo of a replace reads the previous id — its bytes are still there.
    expect((await repository.loadBackgroundImage(doc.metadata.id, 'bg_a'))!.width).toBe(2);
    expect((await repository.loadBackgroundImage(doc.metadata.id, 'bg_b'))!.width).toBe(3);

    await repository.pruneBackgroundImages(doc.metadata.id, { imageId: 'bg_b' });
    expect(await repository.loadBackgroundImage(doc.metadata.id)).toBeNull();
    expect(await repository.loadBackgroundImage(doc.metadata.id, 'bg_a')).toBeNull();
    expect((await repository.loadBackgroundImage(doc.metadata.id, 'bg_b'))!.width).toBe(3);
    expect((await repository.loadBackgroundImage(other.metadata.id))!.width).toBe(4);

    await repository.remove(doc.metadata.id);
    expect(await repository.loadBackgroundImage(doc.metadata.id, 'bg_b')).toBeNull();
    expect((await repository.loadBackgroundImage(other.metadata.id))!.width).toBe(4);
  });

  it('returns null when no background image is stored', async () => {
    const repository = await open();
    expect(await repository.loadBackgroundImage('no-such-document')).toBeNull();
  });

  it('removing a background image clears it independently of the document', async () => {
    const repository = await open();
    const doc = documentWith('Removable background');
    await repository.save(doc);
    await repository.saveBackgroundImage(doc.metadata.id, new Blob(['x']), { width: 10, height: 10 });

    await repository.removeBackgroundImage(doc.metadata.id);

    expect(await repository.loadBackgroundImage(doc.metadata.id)).toBeNull();
    expect(await repository.load(doc.metadata.id)).not.toBeNull();
  });

  it('deleting the document also clears its background image', async () => {
    const repository = await open();
    const doc = documentWith('Deleted with background');
    await repository.save(doc);
    await repository.saveBackgroundImage(doc.metadata.id, new Blob(['x']), { width: 10, height: 10 });

    await repository.remove(doc.metadata.id);

    expect(await repository.loadBackgroundImage(doc.metadata.id)).toBeNull();
  });
});

/** Projects — a flat, optional grouping of canvases. See `document/types.ts`'s `Project`. */
describe.each([
  ['IndexedDbRepository', () => IndexedDbRepository.open()],
  ['MemoryRepository', () => Promise.resolve(new MemoryRepository())],
])('projects (%s)', (_name, open) => {
  it('creates, lists, and renames a project', async () => {
    const repository = await open();
    await repository.saveProject({ id: 'p1', name: 'Payments Platform', createdAt: 1, updatedAt: 1 });

    expect(await repository.listProjects()).toEqual([
      { id: 'p1', name: 'Payments Platform', createdAt: 1, updatedAt: 1 },
    ]);

    await repository.saveProject({ id: 'p1', name: 'Payments', createdAt: 1, updatedAt: 2 });
    expect(await repository.listProjects()).toEqual([{ id: 'p1', name: 'Payments', createdAt: 1, updatedAt: 2 }]);
  });

  it('moves a canvas into a project and back to Unorganized', async () => {
    const repository = await open();
    const doc = documentWith('Checkout');
    await repository.save(doc);
    await repository.saveProject({ id: 'p1', name: 'Payments Platform', createdAt: 1, updatedAt: 1 });

    await repository.moveDocumentToProject(doc.metadata.id, 'p1');
    let list = await repository.list();
    expect(list[0]!.projectId).toBe('p1');

    await repository.moveDocumentToProject(doc.metadata.id, undefined);
    list = await repository.list();
    expect(list[0]!.projectId).toBeUndefined();
  });

  it('deleting a project reassigns its canvases to Unorganized rather than deleting them', async () => {
    const repository = await open();
    const a = documentWith('Checkout');
    const b = documentWith('Refunds');
    await repository.save(a);
    await repository.save(b);
    await repository.saveProject({ id: 'p1', name: 'Payments Platform', createdAt: 1, updatedAt: 1 });
    await repository.moveDocumentToProject(a.metadata.id, 'p1');
    await repository.moveDocumentToProject(b.metadata.id, 'p1');

    await repository.deleteProject('p1');

    const list = await repository.list();
    expect(list).toHaveLength(2);
    expect(list.every((entry) => entry.projectId === undefined)).toBe(true);
    expect(await repository.listProjects()).toHaveLength(0);
  });

  it('duplicating a canvas keeps it in the same project', async () => {
    const repository = await open();
    const original = documentWith('Original');
    await repository.save(original);
    await repository.saveProject({ id: 'p1', name: 'Payments Platform', createdAt: 1, updatedAt: 1 });
    await repository.moveDocumentToProject(original.metadata.id, 'p1');

    const loaded = await repository.load(original.metadata.id);
    await repository.save(cloneDocumentAsNew(loaded!, 'Original copy'));

    const list = await repository.list();
    expect(list.every((entry) => entry.projectId === 'p1')).toBe(true);
  });
});

class RecordingRepository extends MemoryRepository {
  readonly saved: DraftDocument[] = [];

  async save(doc: DraftDocument): Promise<void> {
    this.saved.push(doc);
  }
}

class FullRepository extends MemoryRepository {
  async save(): Promise<void> {
    throw new QuotaExceededError();
  }
}

describe('autosave', () => {
  it('coalesces a burst of edits into a single write', async () => {
    vi.useFakeTimers();
    const repository = new RecordingRepository();
    const saved = repository.saved;

    const states: string[] = [];
    const autosave = new Autosave({
      repository,
      onStateChange: (state) => states.push(state.status),
      debounceMs: 100,
      maxWaitMs: 500,
    });

    for (let i = 0; i < 20; i += 1) {
      autosave.schedule({ ...documentWith(`Edit ${i}`), metadata: documentWith('x').metadata });
      await vi.advanceTimersByTimeAsync(10);
    }
    await vi.advanceTimersByTimeAsync(600);

    // Twenty edits, far fewer writes — and never one per keystroke.
    expect(saved.length).toBeGreaterThan(0);
    expect(saved.length).toBeLessThan(5);
    expect(states).toContain('dirty');
    expect(states).toContain('saved');

    autosave.dispose();
    vi.useRealTimers();
  });

  it('flushes immediately when asked, so a closing tab keeps the work', async () => {
    const repository = new MemoryRepository();
    const autosave = new Autosave({ repository, onStateChange: () => {} });
    const doc = documentWith('Closing');

    autosave.schedule(doc);
    await autosave.flush();

    expect((await repository.load(doc.metadata.id))!.metadata.title).toBe('Closing');
    autosave.dispose();
  });

  it('a flush during an in-flight write waits for it and then writes the newer version', async () => {
    const repository = new MemoryRepository();
    let release: () => void = () => {};
    const realSave = repository.save.bind(repository);
    let calls = 0;
    repository.save = async (doc) => {
      calls += 1;
      if (calls === 1) await new Promise<void>((resolve) => (release = resolve));
      return realSave(doc);
    };
    const autosave = new Autosave({ repository, onStateChange: () => {}, debounceMs: 0 });
    const first = documentWith('First');
    autosave.schedule(first);
    const firstFlush = autosave.flush();
    await Promise.resolve();
    autosave.schedule({ ...first, metadata: { ...first.metadata, title: 'Second' } });
    const secondFlush = autosave.flush();
    release();
    expect(await secondFlush).toBe(true);
    await firstFlush;
    expect((await repository.load(first.metadata.id))!.metadata.title).toBe('Second');
    autosave.dispose();
  });

  it('keeps a version that failed to write so a later flush reports it unsaved', async () => {
    const repository = new FullRepository();
    const autosave = new Autosave({ repository, onStateChange: () => {}, debounceMs: 0 });
    autosave.schedule(documentWith('Too big'));
    expect(await autosave.flush()).toBe(false);
    expect(autosave.hasPendingWork).toBe(true);
    expect(await autosave.flush()).toBe(false);
    autosave.dispose();
  });

  it('reports a storage failure without discarding the document', async () => {
    const repository = new FullRepository();
    const states: { status: string; message?: string }[] = [];
    const autosave = new Autosave({
      repository,
      onStateChange: (state) => states.push(state),
      debounceMs: 0,
    });

    autosave.schedule(documentWith('Too big'));
    await autosave.flush();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const failure = states.find((state) => state.status === 'error');
    expect(failure).toBeDefined();
    expect(failure!.message).toContain('storage space');
    autosave.dispose();
  });
});

/* ------------------------------------------------------- fingerprints ---- */

/** Writes a `documents` row as-is, standing in for a summary an older build
 *  wrote before `shape` existed. */
function putRawSummary(summary: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('draft-canvas');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const tx = req.result.transaction('documents', 'readwrite');
      tx.objectStore('documents').put(summary);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
  });
}

/** Writes an unrecognisable `bodies` row — a crashed write, say. */
function putGarbageBody(id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('draft-canvas');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const tx = req.result.transaction('bodies', 'readwrite');
      tx.objectStore('bodies').put({ id, nonsense: true });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
  });
}

async function stripShape(repository: IndexedDbRepository, id: string): Promise<void> {
  const row = (await repository.list()).find((entry) => entry.id === id)!;
  const { shape: _shape, ...rest } = row;
  await putRawSummary(rest);
}

describe('library fingerprints', () => {
  it('every save writes a shape into the summary, and MemoryRepository derives one too', async () => {
    const repository = await IndexedDbRepository.open();
    const doc = documentWith('Shaped', 2);
    await repository.save(doc);
    const [row] = await repository.list();
    expect(row!.shape?.nodes).toHaveLength(2);
    expect(row!.shape?.nodes[0]![0]).toBe('service');

    const memory = new MemoryRepository();
    await memory.save(doc);
    expect((await memory.list())[0]!.shape?.nodes).toHaveLength(2);
  });

  it('leaves an empty canvas without a shape', async () => {
    const repository = await IndexedDbRepository.open();
    await repository.save(createDocument('Blank'));
    expect((await repository.list())[0]!.shape).toBeUndefined();
  });

  it('backfills rows that lack a shape without touching their order, updatedAt, or bodies', async () => {
    const repository = await IndexedDbRepository.open();
    const older = documentWith('Older', 2);
    const newer = documentWith('Newer', 3);
    await repository.save(older);
    await repository.save({ ...newer, metadata: { ...newer.metadata, updatedAt: newer.metadata.updatedAt + 1000 } });
    const before = await repository.list();
    await stripShape(repository, older.metadata.id);
    await stripShape(repository, newer.metadata.id);
    expect((await repository.list()).every((row) => row.shape === undefined)).toBe(true);
    const bodyBefore = await readRawRow(older.metadata.id);

    expect(await repository.backfillSummaries()).toEqual({ updated: 2, failed: 0, skipped: 0 });

    const after = await repository.list();
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
    expect(after.map((row) => row.updatedAt)).toEqual(before.map((row) => row.updatedAt));
    expect(after.find((row) => row.id === newer.metadata.id)!.shape?.nodes).toHaveLength(3);
    expect(await readRawRow(older.metadata.id)).toEqual(bodyBefore);

    // Nothing left to do: the second launch is free.
    expect(await repository.backfillSummaries()).toEqual({ updated: 0, failed: 0, skipped: 0 });
  });

  it('fingerprints a legacy plaintext body without encrypting it — that is the other sweep\'s job', async () => {
    const repository = await IndexedDbRepository.open();
    const doc = documentWith('Legacy', 2);
    await writeLegacyPlaintextRow(doc);
    const { shape: _shape, ...summary } = await (async () => {
      // Build the summary the old build would have written: counts, no shape.
      const { summarize } = await import('../src/storage/DraftRepository');
      return summarize(doc);
    })();
    await putRawSummary(summary);

    expect(await repository.backfillSummaries()).toMatchObject({ updated: 1, failed: 0 });
    expect((await repository.list())[0]!.shape?.nodes).toHaveLength(2);
    expect(isEncryptedBody(await readRawRow(doc.metadata.id))).toBe(false);
  });

  it('skips empty canvases, counts unreadable bodies as failed, and keeps going', async () => {
    const repository = await IndexedDbRepository.open();
    const blank = createDocument('Blank');
    const good = documentWith('Good', 2);
    await repository.save(blank);
    await repository.save(good);
    await stripShape(repository, good.metadata.id);
    await putRawSummary({ id: 'ghost', title: 'Ghost', createdAt: 1, updatedAt: 1, nodeCount: 4, edgeCount: 0 });
    await putGarbageBody('ghost');

    expect(await repository.backfillSummaries()).toEqual({ updated: 1, failed: 1, skipped: 0 });
    const rows = await repository.list();
    expect(rows.find((row) => row.id === good.metadata.id)!.shape?.nodes).toHaveLength(2);
    expect(rows.find((row) => row.id === 'ghost')!.shape).toBeUndefined();
    expect(rows.find((row) => row.id === blank.metadata.id)!.shape).toBeUndefined();
  });

  it('never clobbers a rename that lands while a body is being read', async () => {
    const repository = await IndexedDbRepository.open();
    const doc = documentWith('Before', 2);
    await repository.save(doc);
    await stripShape(repository, doc.metadata.id);

    // `rename()` goes through `save()`, which writes a fresh, shaped summary —
    // exactly the row the backfill must then leave alone.
    const rename = repository.rename(doc.metadata.id, 'After');
    const backfill = repository.backfillSummaries();
    await Promise.all([rename, backfill]);

    const [row] = await repository.list();
    expect(row!.title).toBe('After');
    expect(row!.shape?.nodes).toHaveLength(2);
  });
});
