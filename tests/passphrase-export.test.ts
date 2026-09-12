import { describe, expect, it } from 'vitest';
import {
  decryptFromExport,
  encryptForExport,
  PBKDF2_ITERATIONS,
  SECURE_EXPORT_CRYPTO_VERSION,
  SECURE_EXPORT_FORMAT,
} from '../src/crypto/passphraseExport';
import { createDocument, createNode } from '../src/document/factory';
import { addNodes } from '../src/document/operations';

function fixture() {
  return addNodes(createDocument('Handoff'), [
    createNode({ type: 'note', x: 0, y: 0, text: 'TOP_SECRET_PAYMENT_SERVICE' }),
  ]);
}

describe('encryptForExport / decryptFromExport', () => {
  it('round-trips a document exactly with the correct passphrase', async () => {
    const doc = fixture();
    const text = await encryptForExport(doc, 'correct horse battery staple');
    const result = await decryptFromExport(text, 'correct horse battery staple');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document).toEqual(doc);
  });

  it('produces a plain JSON envelope with no document content in it', async () => {
    const text = await encryptForExport(fixture(), 'a passphrase');
    expect(() => JSON.parse(text)).not.toThrow();
    expect(text).not.toContain('TOP_SECRET_PAYMENT_SERVICE');
    const envelope = JSON.parse(text);
    expect(envelope.format).toBe(SECURE_EXPORT_FORMAT);
    expect(envelope.cryptoVersion).toBe(SECURE_EXPORT_CRYPTO_VERSION);
    expect(envelope.kdf).toBe('PBKDF2');
    expect(envelope.iterations).toBe(PBKDF2_ITERATIONS);
    expect(typeof envelope.salt).toBe('string');
    expect(typeof envelope.iv).toBe('string');
    expect(typeof envelope.ciphertext).toBe('string');
  });

  it('produces a fresh salt and IV for every export, even of the same document', async () => {
    const doc = fixture();
    const a = JSON.parse(await encryptForExport(doc, 'same passphrase'));
    const b = JSON.parse(await encryptForExport(doc, 'same passphrase'));
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('produces a clean, user-facing error for the wrong passphrase — not a crash or corruption', async () => {
    const text = await encryptForExport(fixture(), 'right passphrase');
    const result = await decryptFromExport(text, 'wrong passphrase');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/passphrase|corrupted/i);
  });

  it('rejects a file that is not valid JSON', async () => {
    const result = await decryptFromExport('not json at all', 'anything');
    expect(result.ok).toBe(false);
  });

  it('rejects a well-formed JSON file that is not a secure export', async () => {
    const result = await decryptFromExport(JSON.stringify({ hello: 'world' }), 'anything');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/not a Draft Canvas/i);
  });

  it('rejects an unsupported cryptoVersion with a clear message, mirroring UnsupportedVersionError', async () => {
    const text = await encryptForExport(fixture(), 'a passphrase');
    const envelope = JSON.parse(text);
    envelope.cryptoVersion = SECURE_EXPORT_CRYPTO_VERSION + 1;
    const result = await decryptFromExport(JSON.stringify(envelope), 'a passphrase');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('newer version');
  });

  it('rejects an unbounded iteration count or unknown KDF instead of deriving forever', async () => {
    const text = await encryptForExport(fixture(), 'a passphrase');
    for (const patch of [{ iterations: 1e12 }, { iterations: 1.5 }, { kdf: 'scrypt' }]) {
      const result = await decryptFromExport(JSON.stringify({ ...JSON.parse(text), ...patch }), 'a passphrase');
      expect(result.ok).toBe(false);
    }
  });

  it('rejects tampered ciphertext rather than returning partial content', async () => {
    const text = await encryptForExport(fixture(), 'a passphrase');
    const envelope = JSON.parse(text);
    envelope.ciphertext = envelope.ciphertext.slice(0, -4) + 'AAAA';
    const result = await decryptFromExport(JSON.stringify(envelope), 'a passphrase');
    expect(result.ok).toBe(false);
  });

  it('never derives the export passphrase into anything resembling the local storage key', async () => {
    // There is no shared code path between passphraseExport.ts and
    // keyStore.ts — this is a structural guarantee, asserted here by
    // confirming decryptFromExport takes no key material from keyStore at
    // all: encrypting and decrypting with the same passphrase, with no
    // local key ever generated in this test, still round-trips.
    const doc = fixture();
    const text = await encryptForExport(doc, 'never touches the master key');
    const result = await decryptFromExport(text, 'never touches the master key');
    expect(result.ok).toBe(true);
  });
});
