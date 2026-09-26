import { PLAIN_STORAGE_VERSION, type EncryptedBody, type PlainBody } from './types';
import { isRecord } from '../lib/isRecord';

/**
 * The plaintext shape every `bodies` row had before encryption existed (builds before 1.0), with no
 * version at all. Still read; a legacy row gains a stamp and a version the first time `load()`
 * writes it back.
 */
export interface LegacyBody {
  id: string;
  document: unknown;
}

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

/** A row written since 2.0: plaintext under `PLAIN_STORAGE_VERSION`, with a per-write stamp. */
export function isPlainBody(row: unknown): row is PlainBody {
  return (
    isRecord(row) &&
    typeof row.id === 'string' &&
    row.storageVersion === PLAIN_STORAGE_VERSION &&
    typeof row.stamp === 'string' &&
    'document' in row
  );
}

/**
 * Deliberately what an older build's own test was — "has a `document` and is not encrypted" — minus
 * the plain shape: a 1.x client reading a 2.0 row sees a legacy plaintext row it can open, and at
 * worst re-encrypts it, which the next 2.0 save undoes. Nothing about the transition can make a row
 * unreadable to either side.
 */
export function isLegacyBody(row: unknown): row is LegacyBody {
  return isRecord(row) && typeof row.id === 'string' && 'document' in row && !isEncryptedBody(row) && !isPlainBody(row);
}
