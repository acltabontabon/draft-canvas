import { AES_GCM, IV_BYTES } from './types';

/**
 * Secure portable export.
 *
 * A `.draftcanvas` file is plain, diffable JSON by design — the export the
 * app writes on every ordinary "Export document." This module is the
 * explicit, separate opt-in for a passphrase-protected copy: the local
 * master key (`keyStore.ts`) never leaves this browser profile and is never
 * used here — instead, a one-off key is *derived from the passphrase itself*
 * via PBKDF2 (a standard, browser-native KDF; no custom cryptography), used
 * only to encrypt/decrypt this one export, and then discarded. The
 * passphrase never becomes, and never touches, the local storage key.
 */

export const SECURE_EXPORT_FORMAT = 'draft-canvas-encrypted';
export const SECURE_EXPORT_FILE_EXTENSION = '.dcenc';
export const SECURE_EXPORT_MIME = 'application/json';
export const SECURE_EXPORT_CRYPTO_VERSION = 1;

/**
 * OWASP's current PBKDF2-HMAC-SHA256 guidance. Stored in every envelope
 * (not just assumed) so raising this default later never breaks importing
 * an older export — the file says what it was actually encrypted with.
 */
export const PBKDF2_ITERATIONS = 600_000;
/** Headroom for a future bump of `PBKDF2_ITERATIONS`, far below "hangs the tab". */
const MAX_IMPORT_ITERATIONS = 10 * PBKDF2_ITERATIONS;
const SALT_BYTES = 16;

export interface SecureExportEnvelope {
  format: typeof SECURE_EXPORT_FORMAT;
  cryptoVersion: number;
  kdf: 'PBKDF2';
  iterations: number;
  /** Each field below is base64 — this is a JSON text file, not raw binary,
   *  so it round-trips through any text-safe channel (email, chat, a repo). */
  salt: string;
  iv: string;
  ciphertext: string;
}

function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Derived fresh for every encrypt/decrypt call, never cached or persisted —
 * there is nothing to reuse across exports, since each gets its own random
 * salt. Non-extractable for the same reason the local master key is: no
 * code path needs the raw bytes back out once derived.
 */
async function deriveExportKey(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    baseKey,
    { name: AES_GCM, length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptForExport(document: unknown, passphrase: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iterations = PBKDF2_ITERATIONS;
  const key = await deriveExportKey(passphrase, salt, iterations);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify(document));
  const ciphertext = await crypto.subtle.encrypt({ name: AES_GCM, iv }, key, plaintext);

  const envelope: SecureExportEnvelope = {
    format: SECURE_EXPORT_FORMAT,
    cryptoVersion: SECURE_EXPORT_CRYPTO_VERSION,
    kdf: 'PBKDF2',
    iterations,
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: toBase64(ciphertext),
  };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

export type DecryptExportResult = { ok: true; document: unknown } | { ok: false; error: string };

function isSecureExportEnvelope(value: unknown): value is SecureExportEnvelope {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    v.format === SECURE_EXPORT_FORMAT &&
    typeof v.cryptoVersion === 'number' &&
    v.kdf === 'PBKDF2' &&
    typeof v.iterations === 'number' &&
    Number.isInteger(v.iterations) &&
    v.iterations > 0 &&
    // The count comes from the file itself: without a ceiling, a crafted
    // `iterations: 1e12` pins the import in key derivation indefinitely.
    v.iterations <= MAX_IMPORT_ITERATIONS &&
    typeof v.salt === 'string' &&
    typeof v.iv === 'string' &&
    typeof v.ciphertext === 'string'
  );
}

/**
 * Decrypts a secure export. A wrong passphrase and a corrupted file produce
 * the same, deliberately unspecific error — AES-GCM's authentication
 * failure looks identical either way, and there is no safe way to tell a
 * user "your passphrase was close" without weakening the guarantee.
 */
export async function decryptFromExport(text: string, passphrase: string): Promise<DecryptExportResult> {
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    return { ok: false, error: 'That file is not valid JSON.' };
  }
  if (!isSecureExportEnvelope(envelope)) {
    return { ok: false, error: 'That file is not a Draft Canvas secure export.' };
  }
  if (envelope.cryptoVersion > SECURE_EXPORT_CRYPTO_VERSION) {
    return {
      ok: false,
      error: `This file was encrypted by a newer version of Draft Canvas (encryption format v${envelope.cryptoVersion}, this app reads up to v${SECURE_EXPORT_CRYPTO_VERSION}).`,
    };
  }
  try {
    const salt = fromBase64(envelope.salt);
    const key = await deriveExportKey(passphrase, salt, envelope.iterations);
    const iv = fromBase64(envelope.iv);
    const ciphertext = fromBase64(envelope.ciphertext);
    const plaintext = await crypto.subtle.decrypt({ name: AES_GCM, iv }, key, ciphertext);
    return { ok: true, document: JSON.parse(new TextDecoder().decode(plaintext)) };
  } catch {
    return { ok: false, error: 'Incorrect passphrase, or this file is corrupted.' };
  }
}
