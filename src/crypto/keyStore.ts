import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { AES_GCM, AES_KEY_LENGTH } from './types';

/**
 * The local encryption key that every build up to 1.11 encrypted stored diagrams with.
 *
 * Since 2.0 nothing is encrypted at rest (see `crypto/types.ts` for why), so this module is a
 * reader: `getMasterKey` opens whatever key an earlier build left behind, and never makes one. A
 * profile with encrypted rows but no key has lost them, and generating a fresh key would only
 * disguise that as a decrypt failure.
 *
 * A single, non-extractable AES-256-GCM `CryptoKey`, generated once on first
 * use and shared by every document in this browser profile — see
 * SECURITY.md for why one profile-wide key rather than one per document.
 * Kept in a database of its own, separate from `draft-canvas` (the document
 * database `IndexedDbRepository` owns): key material and document content
 * are different concerns with different lifecycles, and this keeps the key
 * store's schema from ever needing to change in lockstep with the document
 * schema's.
 *
 * `extractable: false` means the browser will hand back a `CryptoKey`
 * *handle* usable with `crypto.subtle`, but there is no code path — not
 * here, not anywhere — that can pull the raw key bytes back out of it. That
 * property survives the structured-clone round trip through IndexedDB.
 */
const KEY_DB_NAME = 'draft-canvas-keys';
const KEY_DB_VERSION = 1;
const KEY_STORE = 'keys';
const MASTER_KEY_ID = 'master';

interface KeyDb extends DBSchema {
  keys: {
    key: string;
    value: CryptoKey;
  };
}

let dbPromise: Promise<IDBPDatabase<KeyDb>> | null = null;

function openKeyDb(): Promise<IDBPDatabase<KeyDb>> {
  dbPromise ??= openDB<KeyDb>(KEY_DB_NAME, KEY_DB_VERSION, {
    upgrade(database) {
      database.createObjectStore(KEY_STORE);
    },
  }).catch((error: unknown) => {
    // A cached rejection would fail every later save and load until reload.
    dbPromise = null;
    throw error;
  });
  return dbPromise;
}

let cachedKey: Promise<CryptoKey> | null = null;
let cachedRead: Promise<CryptoKey | null> | null = null;

/**
 * The key an earlier build stored, or `null` when this profile never had one. Read once per page
 * load: a profile without a key stays without one, and a key that is there does not move.
 */
export function getMasterKey(): Promise<CryptoKey | null> {
  cachedRead ??= (async () => {
    const db = await openKeyDb();
    return (await db.get(KEY_STORE, MASTER_KEY_ID)) ?? null;
  })().catch((error: unknown) => {
    cachedRead = null;
    throw error;
  });
  return cachedRead;
}

/**
 * The key, made if it is missing. No longer called by the app — it exists so tests can seed the
 * encrypted rows an earlier build would have written — and kept exactly as it was, so a fixture is
 * encrypted the way a real 1.x profile is.
 */
export function getOrCreateMasterKey(): Promise<CryptoKey> {
  // Only a success is worth caching: one transient key-database error must not
  // poison every save and load for the rest of the session.
  cachedKey ??= loadOrGenerateMasterKey().catch((error: unknown) => {
    cachedKey = null;
    throw error;
  });
  return cachedKey;
}

async function loadOrGenerateMasterKey(): Promise<CryptoKey> {
  const db = await openKeyDb();
  const existing = await db.get(KEY_STORE, MASTER_KEY_ID);
  if (existing) return existing;

  // Generated *outside* any transaction: `crypto.subtle.generateKey` is
  // async, and awaiting a non-IndexedDB promise while a transaction is open
  // lets some browsers consider it idle and auto-close it before the
  // following request runs.
  const candidate = await crypto.subtle.generateKey({ name: AES_GCM, length: AES_KEY_LENGTH }, false, [
    'encrypt',
    'decrypt',
  ]);

  // Re-check-and-write inside one short transaction, to narrow (not fully
  // close — IndexedDB has no cross-tab lock) the window where a second tab
  // generates its own key concurrently on a very first use. Whichever write
  // actually lands is the key every tab converges on from here.
  const tx = db.transaction(KEY_STORE, 'readwrite');
  const store = tx.objectStore(KEY_STORE);
  const winner = (await store.get(MASTER_KEY_ID)) ?? candidate;
  if (winner === candidate) await store.put(candidate, MASTER_KEY_ID);
  await tx.done;
  return winner;
}

/**
 * Test seam only: forces the next `getOrCreateMasterKey()` call to hit
 * storage again instead of the in-memory cache. Real app code never calls
 * this — a page reload is what naturally resets the cache in production.
 */
export function __resetKeyCacheForTests(): void {
  cachedKey = null;
  cachedRead = null;
  dbPromise = null;
}
