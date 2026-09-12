import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { encryptDocument, decryptDocument } from '../src/crypto/documentCipher';
import { getOrCreateMasterKey, __resetKeyCacheForTests } from '../src/crypto/keyStore';
import { isEncryptedBody, isLegacyBody, migrateLegacyRecord } from '../src/crypto/migrateStorage';
import * as migrateStorage from '../src/crypto/migrateStorage';
import { CRYPTO_VERSION } from '../src/crypto/types';
import { createDocument, createNode } from '../src/document/factory';
import { addNodes } from '../src/document/operations';
import { IndexedDbRepository } from '../src/storage/IndexedDbRepository';
import type { EncryptedBody } from '../src/crypto/types';

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  __resetKeyCacheForTests();
});

describe('the local master key', () => {
  it('is generated on first use and is non-extractable', async () => {
    const key = await getOrCreateMasterKey();
    expect(key.extractable).toBe(false);
    expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    expect(key.usages.sort()).toEqual(['decrypt', 'encrypt']);
  });

  it('is retrieved, not regenerated, on a later call — same key, encrypted data stays readable', async () => {
    const first = await getOrCreateMasterKey();
    const data = new TextEncoder().encode('hello');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, first, data);

    // A later call in the same session hits the in-memory cache.
    const second = await getOrCreateMasterKey();
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, second, ciphertext);
    expect(new TextDecoder().decode(plaintext)).toBe('hello');
  });

  it('is retrieved from storage across a fresh module state — a new page load, not a new key', async () => {
    const first = await getOrCreateMasterKey();
    const data = new TextEncoder().encode('survives a reload');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, first, data);

    // Simulates a reload: the in-memory cache is gone, but the underlying
    // IndexedDB (not reset here, unlike beforeEach's fresh IDBFactory) still
    // has the key.
    __resetKeyCacheForTests();
    const second = await getOrCreateMasterKey();
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, second, ciphertext);
    expect(new TextDecoder().decode(plaintext)).toBe('survives a reload');
  });

  it('has no code path that returns the raw key material', async () => {
    const key = await getOrCreateMasterKey();
    // The only way to get bytes out of a CryptoKey is exportKey, and it must
    // reject for a non-extractable key — this is the platform's own
    // guarantee, asserted here as documentation of the property this app
    // relies on rather than a claim this app itself enforces.
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
  });
});

describe('encryptDocument / decryptDocument', () => {
  function fixture() {
    return addNodes(createDocument('Secret'), [
      createNode({ type: 'note', x: 0, y: 0, text: 'TOP_SECRET_PAYMENT_SERVICE' }),
    ]);
  }

  it('round-trips a document exactly', async () => {
    const key = await getOrCreateMasterKey();
    const doc = fixture();
    const body = await encryptDocument(doc, key);
    const decrypted = await decryptDocument(body, key);
    expect(decrypted).toEqual(doc);
  });

  it('never contains the plaintext content anywhere in the encrypted record', async () => {
    const key = await getOrCreateMasterKey();
    const body = await encryptDocument(fixture(), key);
    const raw = JSON.stringify({ ...body, iv: Array.from(body.iv), ciphertext: Array.from(new Uint8Array(body.ciphertext)) });
    expect(raw).not.toContain('TOP_SECRET_PAYMENT_SERVICE');
  });

  it('uses a fresh IV for every encryption, even for the same document', async () => {
    const key = await getOrCreateMasterKey();
    const doc = fixture();
    const a = await encryptDocument(doc, key);
    const b = await encryptDocument(doc, key);
    expect(Array.from(a.iv)).not.toEqual(Array.from(b.iv));
  });

  it('IVs are unique across many encryptions', async () => {
    const key = await getOrCreateMasterKey();
    const doc = fixture();
    const ivs = await Promise.all(
      Array.from({ length: 50 }, () => encryptDocument(doc, key).then((b) => Array.from(b.iv).join(','))),
    );
    expect(new Set(ivs).size).toBe(50);
  });

  it('rejects tampered ciphertext rather than returning partial or wrong content', async () => {
    const key = await getOrCreateMasterKey();
    const body = await encryptDocument(fixture(), key);
    const corrupted = new Uint8Array(body.ciphertext);
    corrupted[0] = corrupted[0]! ^ 0xff;
    const tampered: EncryptedBody = { ...body, ciphertext: corrupted.buffer };
    expect(await decryptDocument(tampered, key)).toBeNull();
  });

  it('rejects decryption with the wrong key', async () => {
    const key = await getOrCreateMasterKey();
    const wrongKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
    const body = await encryptDocument(fixture(), key);
    expect(await decryptDocument(body, wrongKey)).toBeNull();
  });

  it('rejects an unsupported cryptoVersion rather than attempting to decrypt it', async () => {
    const key = await getOrCreateMasterKey();
    const body = await encryptDocument(fixture(), key);
    expect(await decryptDocument({ ...body, cryptoVersion: CRYPTO_VERSION + 1 }, key)).toBeNull();
  });

  it('rejects a malformed record (garbage ciphertext) without throwing', async () => {
    const key = await getOrCreateMasterKey();
    const malformed: EncryptedBody = {
      id: 'd1',
      storageVersion: 1,
      cryptoVersion: CRYPTO_VERSION,
      iv: crypto.getRandomValues(new Uint8Array(12)),
      ciphertext: new Uint8Array([1, 2, 3]).buffer,
    };
    await expect(decryptDocument(malformed, key)).resolves.toBeNull();
  });
});

describe('shape guards', () => {
  it('distinguishes an encrypted row from a legacy plaintext one', async () => {
    const key = await getOrCreateMasterKey();
    const encrypted = await encryptDocument(createDocument('A'), key);
    const legacy = { id: 'd1', document: createDocument('B') };

    expect(isEncryptedBody(encrypted)).toBe(true);
    expect(isLegacyBody(encrypted)).toBe(false);
    expect(isEncryptedBody(legacy)).toBe(false);
    expect(isLegacyBody(legacy)).toBe(true);
  });

  it('rejects garbage that matches neither shape', () => {
    expect(isEncryptedBody({ nonsense: true })).toBe(false);
    expect(isLegacyBody({ nonsense: true })).toBe(false);
    expect(isEncryptedBody(null)).toBe(false);
    expect(isLegacyBody(undefined)).toBe(false);
  });
});

describe('migrateLegacyRecord', () => {
  it('encrypts a legacy row and the result decrypts back to the same document', async () => {
    const key = await getOrCreateMasterKey();
    const doc = createDocument('Migrate me');
    const encrypted = await migrateLegacyRecord({ id: doc.metadata.id, document: doc }, key);
    expect(isEncryptedBody(encrypted)).toBe(true);
    expect(await decryptDocument(encrypted, key)).toEqual(doc);
  });
});

describe('IndexedDbRepository.migrateLegacyRecords — the proactive sweep', () => {
  function seedLegacyRow(document: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('draft-canvas');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const tx = req.result.transaction('bodies', 'readwrite');
        tx.objectStore('bodies').put({ id: (document as { metadata: { id: string } }).metadata.id, document });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      };
    });
  }

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

  it('encrypts every legacy record in storage, not only the ones opened', async () => {
    const repository = await IndexedDbRepository.open();
    const untouched = createDocument('Never opened');
    await seedLegacyRow(untouched);

    const result = await repository.migrateLegacyRecords();
    expect(result).toEqual({ migrated: 1, failed: 0 });

    const raw = await readRawRow(untouched.metadata.id);
    expect(isEncryptedBody(raw)).toBe(true);
    const key = await getOrCreateMasterKey();
    expect(await decryptDocument(raw as EncryptedBody, key)).toEqual(untouched);
  });

  it('never overwrites a record that was saved while the sweep was encrypting it', async () => {
    const repository = await IndexedDbRepository.open();
    const stale = createDocument('Before edit');
    await seedLegacyRow(stale);
    const edited = { ...stale, metadata: { ...stale.metadata, title: 'After edit' } };
    const spy = vi.spyOn(migrateStorage, 'migrateLegacyRecord').mockImplementationOnce(async (row, key) => {
      await repository.save(edited);
      return migrateLegacyRecord(row, key);
    });

    await repository.migrateLegacyRecords();
    spy.mockRestore();

    expect((await repository.load(stale.metadata.id))!.metadata.title).toBe('After edit');
  });

  it('leaves already-encrypted records untouched', async () => {
    const repository = await IndexedDbRepository.open();
    const doc = createDocument('Already safe');
    await repository.save(doc);
    const before = await readRawRow(doc.metadata.id);

    const result = await repository.migrateLegacyRecords();
    expect(result).toEqual({ migrated: 0, failed: 0 });

    const after = await readRawRow(doc.metadata.id);
    expect(after).toEqual(before);
  });

  it('is a no-op on an empty store', async () => {
    const repository = await IndexedDbRepository.open();
    expect(await repository.migrateLegacyRecords()).toEqual({ migrated: 0, failed: 0 });
  });

  it('never deletes the plaintext record before the encrypted one is verified and written', async () => {
    // migrateLegacyRecord always verifies (decrypts its own output) before
    // returning — the repository's sweep only calls `db.put`, a single
    // atomic write, with what that function hands back. There is no
    // intermediate "deleted but not yet re-written" state to land in.
    const repository = await IndexedDbRepository.open();
    const doc = createDocument('Safety net');
    await seedLegacyRow(doc);

    await repository.migrateLegacyRecords();
    const raw = await readRawRow(doc.metadata.id);
    expect(raw).not.toBeNull();
    expect(isEncryptedBody(raw)).toBe(true);
  });
});
