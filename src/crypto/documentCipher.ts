import { AES_GCM, CRYPTO_VERSION, IV_BYTES, STORAGE_VERSION, type EncryptedBody } from './types';

/**
 * The encryption boundary for a single document body. Nothing outside this
 * module (and `keyStore.ts`, for the key itself) touches `crypto.subtle`
 * directly — see `docs/ARCHITECTURE.md`'s note on the encrypted-storage
 * boundary. Callers pass a plain `DraftDocument`-shaped value in and get an
 * opaque `EncryptedBody` out (or the reverse); neither direction knows or
 * cares about IndexedDB, the document schema, or migration.
 */

export async function encryptDocument(document: unknown, key: CryptoKey): Promise<EncryptedBody> {
  const id = (document as { metadata?: { id?: unknown } })?.metadata?.id;
  if (typeof id !== 'string' || !id) {
    throw new Error('Cannot encrypt a document with no metadata.id.');
  }

  // A fresh, cryptographically random IV for every single encryption —
  // reusing one with the same AES-GCM key would break its authentication
  // guarantee, not just its confidentiality. See SECURITY.md.
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify(document));
  const ciphertext = await crypto.subtle.encrypt({ name: AES_GCM, iv }, key, plaintext);

  return { id, storageVersion: STORAGE_VERSION, cryptoVersion: CRYPTO_VERSION, iv, ciphertext };
}

/**
 * Decrypts and JSON-parses a body. Returns `null` on *any* failure —
 * tampered ciphertext (AES-GCM's authentication tag won't verify), a wrong
 * key, a corrupt or truncated record, an unsupported `cryptoVersion` — and
 * never partially. The caller (`IndexedDbRepository`) treats a `null` here
 * exactly like an unreadable plaintext record always was: log a warning,
 * return nothing, and critically, never overwrite the still-encrypted
 * record just because this read failed. The result is intentionally
 * `unknown`, not `DraftDocument` — it still has to pass through
 * `document/validate.ts`'s normal untrusted-input funnel afterward, the
 * same as a freshly imported file.
 */
export async function decryptDocument(body: EncryptedBody, key: CryptoKey): Promise<unknown | null> {
  if (body.cryptoVersion !== CRYPTO_VERSION) return null;
  try {
    const plaintext = await crypto.subtle.decrypt({ name: AES_GCM, iv: body.iv }, key, body.ciphertext);
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    return null;
  }
}
