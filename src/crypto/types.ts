/**
 * The on-disk shape of a document body written today: the document itself, as JSON-compatible
 * plaintext, under a storage version that says so. `stamp` is fresh on every write, so two reads of
 * the row can be told apart (see `sameBody` in `IndexedDbRepository.ts`) — the job an encrypted
 * row's IV used to do.
 *
 * Plaintext on purpose. Diagrams written before this were encrypted with a key kept in the same
 * browser profile, one origin over from the data; that hid the bodies from a dump of one database
 * without the other and from little else, while making saving impossible over plain http and every
 * diagram unreadable if only the key store was lost. Old rows stay readable (`EncryptedBody`
 * below); nothing rewrites them until they are next saved.
 */
export interface PlainBody {
  id: string;
  storageVersion: typeof PLAIN_STORAGE_VERSION;
  stamp: string;
  document: unknown;
}

export const PLAIN_STORAGE_VERSION = 2;

/**
 * The on-disk shape of an encrypted document body, as every build up to 1.11 wrote it. Read, never
 * written, since 2.0. Two separate version
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
