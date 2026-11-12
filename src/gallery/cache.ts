/**
 * The downloaded gallery, kept in its own IndexedDB database (`draft-canvas-starters`) apart from
 * diagrams: the catalog as last read, each starter file by its SHA-256, and which version of each
 * starter the person has already looked at. Clearing it ("Clear downloaded starters") never touches
 * a diagram.
 *
 * Every read tolerates a missing or blocked database: without storage the gallery still works for
 * the session, it just isn't remembered.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { GalleryCatalog } from './catalog';

const DB_NAME = 'draft-canvas-starters';
const DB_VERSION = 1;

export interface CachedGallery {
  catalog: GalleryCatalog;
  fetchedAt: number;
}

interface GalleryDb extends DBSchema {
  meta: { key: string; value: unknown };
  files: { key: string; value: { sha256: string; text: string } };
}

let opening: Promise<IDBPDatabase<GalleryDb> | null> | null = null;

function database(): Promise<IDBPDatabase<GalleryDb> | null> {
  opening ??= openDB<GalleryDb>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'sha256' });
    },
  }).catch(() => {
    opening = null;
    return null;
  });
  return opening;
}

async function readMeta<T>(key: string): Promise<T | undefined> {
  try {
    return (await (await database())?.get('meta', key)) as T | undefined;
  } catch {
    return undefined;
  }
}

async function writeMeta(key: string, value: unknown): Promise<void> {
  try {
    await (await database())?.put('meta', value, key);
  } catch {
    // Not remembered; the gallery still works for this session.
  }
}

export function readCachedGallery(): Promise<CachedGallery | undefined> {
  return readMeta<CachedGallery>('gallery');
}

export function writeCachedGallery(gallery: CachedGallery): Promise<void> {
  return writeMeta('gallery', gallery);
}

/** Starter id → the SHA-256 the person last looked at. Empty until the gallery first loads. */
export async function readSeen(): Promise<Record<string, string>> {
  return (await readMeta<Record<string, string>>('seen')) ?? {};
}

export function writeSeen(seen: Record<string, string>): Promise<void> {
  return writeMeta('seen', seen);
}

/** Canvas id → the starter version whose "updated" note was dismissed on it. */
export async function readDismissed(): Promise<Record<string, string>> {
  return (await readMeta<Record<string, string>>('dismissed')) ?? {};
}

export function writeDismissed(dismissed: Record<string, string>): Promise<void> {
  return writeMeta('dismissed', dismissed);
}

export async function readFile(sha256: string): Promise<string | undefined> {
  try {
    return (await (await database())?.get('files', sha256))?.text;
  } catch {
    return undefined;
  }
}

export async function cachedFileKeys(): Promise<Set<string>> {
  try {
    return new Set((await (await database())?.getAllKeys('files')) ?? []);
  } catch {
    return new Set();
  }
}

export async function writeFile(sha256: string, text: string): Promise<void> {
  try {
    await (await database())?.put('files', { sha256, text });
  } catch {
    // As above.
  }
}

/** Removes every file no longer in the catalog. */
export async function pruneFiles(keep: ReadonlySet<string>): Promise<void> {
  try {
    const db = await database();
    if (!db) return;
    for (const key of await db.getAllKeys('files')) if (!keep.has(key)) await db.delete('files', key);
  } catch {
    // A stale file costs a few kilobytes; nothing to report.
  }
}

/** "Clear downloaded starters": everything this database holds. */
export async function clearGalleryCache(): Promise<void> {
  try {
    const db = await database();
    if (!db) return;
    await db.clear('meta');
    await db.clear('files');
  } catch {
    // As above.
  }
}
