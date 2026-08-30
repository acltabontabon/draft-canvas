/**
 * The on-disk shape of an encrypted document body. Two separate version
 * numbers on purpose: `storageVersion` is this envelope's own shape (bump it
 * if the *record* format changes — new fields, a different algorithm),
 * `cryptoVersion` is the algorithm/parameters used for the ciphertext itself.
 * Neither is the document's own schema `version` (`document/types.ts`) — that
 * lives *inside* the plaintext this envelope wraps, and is a completely
 * separate concern read only by `document/migrate.ts`.
 */
export interface EncryptedBody {
  id: string;
  storageVersion: number;
  cryptoVersion: number;
  /** AES-GCM nonce, 12 bytes, fresh for every encryption — never reused. */
  iv: Uint8Array<ArrayBuffer>;
  ciphertext: ArrayBuffer;
}

export const STORAGE_VERSION = 1;
export const CRYPTO_VERSION = 1;

export const AES_GCM = 'AES-GCM' as const;
export const AES_KEY_LENGTH = 256;
/** NIST-recommended nonce length for AES-GCM. */
export const IV_BYTES = 12;
