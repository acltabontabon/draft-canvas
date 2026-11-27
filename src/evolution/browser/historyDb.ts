/**
 * IndexedDB `draft-canvas-history`: where the browser keeps diagram history. Opened only in the
 * history worker; the editor never reads it directly.
 *
 * - `files`: the isomorphic-git file system (`kvfs.ts`), one bare repository per `/<repoId>`.
 * - `state`: small JSON records — working-copy bindings and the device's history settings.
 *
 * Each write is its own transaction with `durability: 'strict'`, resolved only once committed, so
 * a crash can lose at most the write in flight and never one already reported. The name is a
 * constant (tests/privacy.test.ts): storage is per origin, never derived from the URL.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Entry, KvStore } from './kvfs';

const HISTORY_DB_NAME = 'draft-canvas-history';
const HISTORY_DB_VERSION = 1;

interface HistoryDb extends DBSchema {
  files: { key: string; value: Entry };
  state: { key: string; value: unknown };
}

let opening: Promise<IDBPDatabase<HistoryDb>> | undefined;

export function historyDb(): Promise<IDBPDatabase<HistoryDb>> {
  opening ??= openDB<HistoryDb>(HISTORY_DB_NAME, HISTORY_DB_VERSION, {
    upgrade(database) {
      if (!database.objectStoreNames.contains('files')) database.createObjectStore('files');
      if (!database.objectStoreNames.contains('state')) database.createObjectStore('state');
    },
    blocking(_current, _next, event) {
      // Another tab is upgrading: let it, and reopen on the next call.
      (event.target as IDBDatabase | null)?.close();
      opening = undefined;
    },
  }).catch((error: unknown) => {
    opening = undefined;
    throw error;
  });
  return opening;
}

const STRICT = { durability: 'strict' } as const;

export class IdbKv implements KvStore {
  async get(path: string): Promise<Entry | undefined> {
    return (await historyDb()).get('files', path);
  }
  async put(path: string, entry: Entry): Promise<void> {
    const tx = (await historyDb()).transaction('files', 'readwrite', STRICT);
    await tx.store.put(entry, path);
    await tx.done;
  }
  async delete(path: string): Promise<void> {
    const tx = (await historyDb()).transaction('files', 'readwrite', STRICT);
    await tx.store.delete(path);
    await tx.done;
  }
  async keysUnder(prefix: string): Promise<string[]> {
    const range = IDBKeyRange.bound(`${prefix}/`, `${prefix}/￿`);
    return (await historyDb()).getAllKeys('files', range);
  }
}

export async function readState<T>(key: string): Promise<T | undefined> {
  return (await historyDb()).get('state', key) as Promise<T | undefined>;
}

export async function writeState(key: string, value: unknown): Promise<void> {
  const tx = (await historyDb()).transaction('state', 'readwrite', STRICT);
  await tx.store.put(value, key);
  await tx.done;
}

export async function deleteState(key: string): Promise<void> {
  const tx = (await historyDb()).transaction('state', 'readwrite', STRICT);
  await tx.store.delete(key);
  await tx.done;
}

export async function listState(prefix: string): Promise<{ key: string; value: unknown }[]> {
  const db = await historyDb();
  const range = IDBKeyRange.bound(prefix, `${prefix}￿`);
  const keys = await db.getAllKeys('state', range);
  const values = await db.getAll('state', range);
  return keys.map((key, i) => ({ key, value: values[i] }));
}
