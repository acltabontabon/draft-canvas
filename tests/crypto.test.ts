import { beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { encryptDocument, decryptDocument } from '../src/crypto/documentCipher';
import { getMasterKey, getOrCreateMasterKey, __resetKeyCacheForTests } from '../src/crypto/keyStore';
import { isEncryptedBody, isLegacyBody, isPlainBody } from '../src/crypto/bodyShapes';
import { CRYPTO_VERSION } from '../src/crypto/types';
import { createDocument, createNode } from '../src/document/factory';
import { addNodes } from '../src/document/operations';

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

  it('tells a plain 2.0 row from both, and a 1.x build would read it as legacy plaintext', () => {
    const plain = { id: 'd1', storageVersion: 2, stamp: 'b_1', document: createDocument('C') };
    expect(isPlainBody(plain)).toBe(true);
    expect(isEncryptedBody(plain)).toBe(false);
    expect(isLegacyBody(plain)).toBe(false);
    // What `isLegacyBody` was before the plain shape existed: has a `document`, is not encrypted.
    expect('document' in plain && !isEncryptedBody(plain)).toBe(true);
    expect(isPlainBody({ id: 'd1', document: createDocument('D') })).toBe(false);
    expect(isPlainBody({ id: 'd1', storageVersion: 2, document: createDocument('D') })).toBe(false);
  });

  it('rejects garbage that matches no shape', () => {
    expect(isEncryptedBody({ nonsense: true })).toBe(false);
    expect(isLegacyBody({ nonsense: true })).toBe(false);
    expect(isPlainBody({ nonsense: true })).toBe(false);
    expect(isEncryptedBody(null)).toBe(false);
    expect(isLegacyBody(undefined)).toBe(false);
  });
});

describe('reading the key an earlier build left', () => {
  it('is null on a profile that never had one, and makes none', async () => {
    expect(await getMasterKey()).toBeNull();
    __resetKeyCacheForTests();
    expect(await getMasterKey()).toBeNull();
  });

  it('finds the key a 1.x build stored', async () => {
    const seeded = await getOrCreateMasterKey();
    __resetKeyCacheForTests();
    const read = await getMasterKey();
    expect(read).not.toBeNull();
    const doc = createDocument('E');
    const encrypted = await encryptDocument(doc, seeded);
    expect(await decryptDocument(encrypted, read!)).toEqual(doc);
  });
});
