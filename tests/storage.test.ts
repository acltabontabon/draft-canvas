import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { cloneDocumentAsNew, createDocument, createNode } from '../src/document/factory';
import { addNodes } from '../src/document/operations';
import { IndexedDbRepository } from '../src/storage/IndexedDbRepository';
import { MemoryRepository } from '../src/storage/MemoryRepository';
import { Autosave } from '../src/storage/autosave';
import { QuotaExceededError } from '../src/storage/DraftRepository';
import { decryptDocument } from '../src/crypto/documentCipher';
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
