import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { AES_GCM, AES_KEY_LENGTH } from './types';

/**
 * The local encryption key.
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
  });
  return dbPromise;
}

let cachedKey: Promise<CryptoKey> | null = null;

/**
 * The local encryption key — generated on first call, read from storage on
 * every call after that until the page reloads (the in-memory cache avoids
 * a round trip per save/load without holding the key anywhere longer-lived
 * than this module's own state).
 */
export function getOrCreateMasterKey(): Promise<CryptoKey> {
  cachedKey ??= loadOrGenerateMasterKey();
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
  dbPromise = null;
}
