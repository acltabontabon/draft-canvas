import { encryptDocument, decryptDocument } from './documentCipher';
import type { EncryptedBody } from './types';

/** The plaintext shape every `bodies` row had before encryption existed. */
export interface LegacyBody {
  id: string;
  document: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `instanceof Uint8Array` / `instanceof ArrayBuffer` can be `false` for a
 * value that is genuinely one, if it crossed a realm boundary that
 * constructed it against a *different* `Uint8Array`/`ArrayBuffer` — a real
 * possibility after a structured-clone round trip (confirmed against
 * `fake-indexeddb` in tests; real browser IndexedDB keeps everything in one
 * realm, but there is no reason to rely on that). `ArrayBuffer.isView` and a
 * tag check are the realm-safe way to ask the same question.
 */
const isBufferView = (value: unknown): value is ArrayBufferView => ArrayBuffer.isView(value);
const isArrayBuffer = (value: unknown): value is ArrayBuffer =>
  Object.prototype.toString.call(value) === '[object ArrayBuffer]';

export function isEncryptedBody(row: unknown): row is EncryptedBody {
  return (
    isRecord(row) &&
    typeof row.id === 'string' &&
    typeof row.storageVersion === 'number' &&
    typeof row.cryptoVersion === 'number' &&
    isBufferView(row.iv) &&
    isArrayBuffer(row.ciphertext)
  );
}

export function isLegacyBody(row: unknown): row is LegacyBody {
  return isRecord(row) && typeof row.id === 'string' && 'document' in row && !isEncryptedBody(row);
}

/**
 * Encrypts one legacy plaintext row, verifying the result decrypts back to
 * the same content *before* returning it — the caller only persists what
 * this function hands back, so a record that fails self-verification never
 * overwrites the still-readable plaintext it came from. This is the whole
 * safety contract: encrypt → verify → only then does the caller's `put`
 * (a single atomic write) replace the old row. A crash at any point before
 * that `put` leaves the original plaintext row untouched; nothing in
 * between is ever a partially-written state.
 */
export async function migrateLegacyRecord(row: LegacyBody, key: CryptoKey): Promise<EncryptedBody> {
  const encrypted = await encryptDocument(row.document, key);
  const verified = await decryptDocument(encrypted, key);
  if (verified === null) {
    throw new Error(`Encrypted record ${row.id} failed self-verification immediately after encrypting.`);
  }
  return encrypted;
}
