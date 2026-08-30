import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { normalizeDocument } from '../document/validate';
import {
  QuotaExceededError,
  StorageUnavailableError,
  isQuotaError,
  summarize,
  type DraftRepository,
} from './DraftRepository';
import type { DraftDocument, DraftSummary } from '../document/types';

const DB_NAME = 'draft-canvas';
const DB_VERSION = 1;

/**
 * Meta and body live in separate stores on purpose: rendering the library only
 * needs titles and timestamps, and pulling a dozen full documents — code cards
 * and all — just to draw a list would make the landing screen sluggish.
 */
interface DraftDb extends DBSchema {
  documents: {
    key: string;
    value: DraftSummary;
    indexes: { updatedAt: number };
  };
  bodies: {
    key: string;
    value: { id: string; document: DraftDocument };
  };
}

export class IndexedDbRepository implements DraftRepository {
  readonly kind = 'indexeddb' as const;
  readonly durable = true;

  private readonly db: IDBPDatabase<DraftDb>;

  private constructor(db: IDBPDatabase<DraftDb>) {
    this.db = db;
  }

  static async open(): Promise<IndexedDbRepository> {
    if (typeof indexedDB === 'undefined') throw new StorageUnavailableError();
    try {
      const db = await openDB<DraftDb>(DB_NAME, DB_VERSION, {
        upgrade(database) {
          if (!database.objectStoreNames.contains('documents')) {
            const store = database.createObjectStore('documents', { keyPath: 'id' });
            store.createIndex('updatedAt', 'updatedAt');
          }
          if (!database.objectStoreNames.contains('bodies')) {
            database.createObjectStore('bodies', { keyPath: 'id' });
          }
        },
        blocked() {
          console.warn('[draft-canvas] Another tab is holding an older database version open.');
        },
        terminated() {
          console.warn('[draft-canvas] The local database connection was closed unexpectedly.');
        },
      });
      return new IndexedDbRepository(db);
    } catch (error) {
      throw new StorageUnavailableError(error);
    }
  }

  async list(): Promise<DraftSummary[]> {
    const rows = await this.db.getAllFromIndex('documents', 'updatedAt');
    // The index sorts ascending; the library wants most-recent first.
    return rows.reverse();
  }

  /**
   * Loads and re-validates. A record can be corrupted by a crashed write or by
   * a older/newer build of the app, and it is better to open a repaired diagram
   * than to show an error page over somebody's only copy.
   */
  async load(id: string): Promise<DraftDocument | null> {
    const row = await this.db.get('bodies', id);
    if (!row) return null;
    const result = normalizeDocument(row.document);
    if (!result.ok) {
      console.warn(`[draft-canvas] Local record ${id} is unreadable: ${result.error}`);
      return null;
    }
    return result.document;
  }

  async save(document: DraftDocument): Promise<void> {
    try {
      const tx = this.db.transaction(['documents', 'bodies'], 'readwrite');
      await Promise.all([
        tx.objectStore('documents').put(summarize(document)),
        tx.objectStore('bodies').put({ id: document.metadata.id, document }),
        tx.done,
      ]);
    } catch (error) {
      if (isQuotaError(error)) throw new QuotaExceededError(error);
      throw error;
    }
  }

  async remove(id: string): Promise<void> {
    const tx = this.db.transaction(['documents', 'bodies'], 'readwrite');
    await Promise.all([
      tx.objectStore('documents').delete(id),
      tx.objectStore('bodies').delete(id),
      tx.done,
    ]);
  }

  async rename(id: string, title: string): Promise<void> {
    const document = await this.load(id);
    if (!document) return;
    document.metadata = { ...document.metadata, title, updatedAt: Date.now() };
    await this.save(document);
  }

  async usage(): Promise<{ usage: number; quota: number } | null> {
    if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
    try {
      const estimate = await navigator.storage.estimate();
      return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 };
    } catch {
      return null;
    }
  }
}
