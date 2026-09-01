import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { requestPersistentStorage } from '../lib/storagePersistence';
import { parseDocument } from '../document/validate';
import { decryptDocument, encryptDocument } from '../crypto/documentCipher';
import { getOrCreateMasterKey } from '../crypto/keyStore';
import { isEncryptedBody, isLegacyBody, migrateLegacyRecord, type LegacyBody } from '../crypto/migrateStorage';
import type { EncryptedBody } from '../crypto/types';
import {
  QuotaExceededError,
  StorageUnavailableError,
  isQuotaError,
  summarize,
  type DraftRepository,
} from './DraftRepository';
import type { DraftDocument, DraftSummary, Project } from '../document/types';

const DB_NAME = 'draft-canvas';
const DB_VERSION = 3;

/** Ask for persistent storage once there's something worth protecting, not
 *  on every save — see `requestPersistentStorage`. */
let persistenceRequested = false;

/**
 * Meta and body live in separate stores on purpose: rendering the library only
 * needs titles and timestamps, and pulling a dozen full documents — code cards
 * and all — just to draw a list would make the landing screen sluggish.
 *
 * A `bodies` row is `EncryptedBody` for every document written by this build
 * or later, or the plaintext `LegacyBody` shape (`{ id, document }`) for one
 * still sitting untouched from before encryption existed. Distinguished by
 * shape, not a flag — the same repair-don't-reject discipline
 * `document/validate.ts` already uses. See `crypto/migrateStorage.ts`.
 */
/**
 * One row per document id — deliberately not a generic, content-hashed asset
 * table. Phase 5.1 only ever needs a single background image per document;
 * building dedup/reference-counting for a future asset system that doesn't
 * exist yet would be speculative. Stored unencrypted, unlike `bodies`: a
 * wallpaper image is far less sensitive than diagram content, and threading
 * AES-GCM through a `Blob` buys little for a lot of extra plumbing.
 */
interface BackgroundImageRow {
  id: string;
  blob: Blob;
  mimeType: string;
  width: number;
  height: number;
}

interface DraftDb extends DBSchema {
  documents: {
    key: string;
    value: DraftSummary;
    indexes: { updatedAt: number };
  };
  bodies: {
    key: string;
    value: EncryptedBody | LegacyBody;
  };
  backgroundImages: {
    key: string;
    value: BackgroundImageRow;
  };
  projects: {
    key: string;
    value: Project;
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
          if (!database.objectStoreNames.contains('backgroundImages')) {
            database.createObjectStore('backgroundImages', { keyPath: 'id' });
          }
          if (!database.objectStoreNames.contains('projects')) {
            database.createObjectStore('projects', { keyPath: 'id' });
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
   * Loads, decrypts, migrates, and re-validates. A record can be corrupted by
   * a crashed write, be sitting in an older schema because it was last saved
   * by an earlier build (`parseDocument` handles this, the same way it does
   * for an imported `.draftcanvas` file), or — before this build — never
   * have been encrypted at all. All three are repaired here, in place, on
   * next open, rather than staying frozen in their old shape forever.
   *
   * A genuine change — decrypting a legacy plaintext row for the first time,
   * or a real schema-version migration — is written straight back: "derive
   * it once, then persist it" only holds if a load that never turns into an
   * edit still ends up current on disk, rather than silently re-deriving the
   * same work on every future open. A same-version repair (e.g. a dangling
   * edge dropped) is left for the next real edit to persist, same as always.
   */
  async load(id: string): Promise<DraftDocument | null> {
    const row = await this.db.get('bodies', id);
    if (!row) return null;

    const wasEncrypted = isEncryptedBody(row);
    let rawDocument: unknown;
    if (wasEncrypted) {
      const key = await getOrCreateMasterKey();
      rawDocument = await decryptDocument(row, key);
      if (rawDocument === null) {
        console.warn(
          `[draft-canvas] Local record ${id} could not be decrypted or has been corrupted.`,
        );
        return null;
      }
    } else if (isLegacyBody(row)) {
      rawDocument = row.document;
    } else {
      console.warn(`[draft-canvas] Local record ${id} is not in a recognised shape.`);
      return null;
    }

    const result = parseDocument(rawDocument);
    if (!result.ok) {
      console.warn(`[draft-canvas] Local record ${id} is unreadable: ${result.error}`);
      return null;
    }

    const priorVersion = isRecord(rawDocument) ? rawDocument.version : undefined;
    if (!wasEncrypted || priorVersion !== result.document.version) {
      await this.save(result.document);
    }
    return result.document;
  }

  async save(document: DraftDocument): Promise<void> {
    try {
      const key = await getOrCreateMasterKey();
      const encrypted = await encryptDocument(document, key);
      const tx = this.db.transaction(['documents', 'bodies'], 'readwrite');
      await Promise.all([
        tx.objectStore('documents').put(summarize(document)),
        tx.objectStore('bodies').put(encrypted),
        tx.done,
      ]);
      if (!persistenceRequested) {
        persistenceRequested = true;
        requestPersistentStorage();
      }
    } catch (error) {
      if (isQuotaError(error)) throw new QuotaExceededError(error);
      throw error;
    }
  }

  async remove(id: string): Promise<void> {
    const tx = this.db.transaction(['documents', 'bodies', 'backgroundImages'], 'readwrite');
    await Promise.all([
      tx.objectStore('documents').delete(id),
      tx.objectStore('bodies').delete(id),
      tx.objectStore('backgroundImages').delete(id),
      tx.done,
    ]);
  }

  async rename(id: string, title: string): Promise<void> {
    const document = await this.load(id);
    if (!document) return;
    document.metadata = { ...document.metadata, title, updatedAt: Date.now() };
    await this.save(document);
  }

  async listProjects(): Promise<Project[]> {
    return this.db.getAll('projects');
  }

  async saveProject(project: Project): Promise<void> {
    await this.db.put('projects', project);
  }

  /**
   * Reassigns every member canvas to Unorganized before removing the
   * project row, mirroring `rename()`'s load-mutate-save shape for each one
   * so the encrypted body and the plaintext summary stay in sync exactly as
   * a title edit already does. Projects are never large enough (this is a
   * flat, un-nested grouping, not a file tree) for that per-canvas cost to
   * matter at the scale this feature targets.
   */
  async deleteProject(id: string): Promise<void> {
    const members = (await this.list()).filter((summary) => summary.projectId === id);
    for (const member of members) {
      await this.moveDocumentToProject(member.id, undefined);
    }
    await this.db.delete('projects', id);
  }

  async moveDocumentToProject(id: string, projectId: string | undefined): Promise<void> {
    const document = await this.load(id);
    if (!document) return;
    const metadata = { ...document.metadata, updatedAt: Date.now() };
    if (projectId) metadata.projectId = projectId;
    else delete metadata.projectId;
    document.metadata = metadata;
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

  /**
   * Encrypts every legacy plaintext record still sitting in storage — not
   * just the ones the user happens to open. `load()` already migrates a
   * record the moment it's opened; this closes the rest of the gap, so a
   * diagram nobody has looked at since before encryption existed doesn't
   * stay plaintext indefinitely. Meant to be kicked off once, non-blocking,
   * at app startup (see `src/store/useDocumentSession.ts`) — it does not
   * block opening or editing any document while it runs.
   *
   * Each record is encrypted, verified by decrypting the result back, and
   * only then written — one atomic `put` per record — exactly the same
   * encrypt→verify→persist contract `load()`'s lazy path follows. A record
   * this sweep hasn't reached yet is simply still plaintext; nothing here is
   * a partially-migrated state.
   */
  async migrateLegacyRecords(): Promise<{ migrated: number; failed: number }> {
    const all = await this.db.getAll('bodies');
    const legacy = all.filter(isLegacyBody);
    if (legacy.length === 0) return { migrated: 0, failed: 0 };

    const key = await getOrCreateMasterKey();
    let migrated = 0;
    let failed = 0;
    for (const row of legacy) {
      try {
        const encrypted = await migrateLegacyRecord(row, key);
        await this.db.put('bodies', encrypted);
        migrated += 1;
      } catch (error) {
        failed += 1;
        console.warn(`[draft-canvas] Could not migrate local record ${row.id} to encrypted storage:`, error);
      }
    }
    return { migrated, failed };
  }

  async saveBackgroundImage(
    documentId: string,
    blob: Blob,
    dims: { width: number; height: number },
  ): Promise<void> {
    try {
      await this.db.put('backgroundImages', {
        id: documentId,
        blob,
        mimeType: blob.type,
        width: dims.width,
        height: dims.height,
      });
    } catch (error) {
      if (isQuotaError(error)) throw new QuotaExceededError(error);
      throw error;
    }
  }

  async loadBackgroundImage(
    documentId: string,
  ): Promise<{ blob: Blob; width: number; height: number } | null> {
    const row = await this.db.get('backgroundImages', documentId);
    if (!row) return null;
    // Some IndexedDB implementations don't round-trip a Blob's `type` through
    // structured clone — `mimeType` is stored alongside for exactly this case.
    const blob = row.blob.type ? row.blob : new Blob([row.blob], { type: row.mimeType });
    return { blob, width: row.width, height: row.height };
  }

  async removeBackgroundImage(documentId: string): Promise<void> {
    await this.db.delete('backgroundImages', documentId);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
