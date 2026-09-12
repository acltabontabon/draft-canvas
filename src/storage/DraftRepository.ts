import { libraryShapeOf } from '../document/shape';
import type { DraftDocument, DraftSummary, Project } from '../document/types';

/**
 * Persistence contract. Two implementations exist: IndexedDB (the real one) and
 * an in-memory fallback used when IndexedDB is blocked — private windows, some
 * embedded webviews, storage disabled by policy — and by unit tests.
 *
 * Nothing here talks to a network. That is the whole point.
 */
export interface DraftRepository {
  /** Human-readable name of the backing store, shown in the privacy panel. */
  readonly kind: 'indexeddb' | 'memory';
  /** True when writes survive a page reload. */
  readonly durable: boolean;

  list(): Promise<DraftSummary[]>;
  load(id: string): Promise<DraftDocument | null>;
  save(document: DraftDocument): Promise<void>;
  remove(id: string): Promise<void>;
  rename(id: string, title: string): Promise<void>;
  /** Estimated bytes used, when the browser will tell us. */
  usage(): Promise<{ usage: number; quota: number } | null>;

  /**
   * Projects — a flat, optional grouping of canvases (see `Project` in
   * `document/types.ts`). No nesting, no canvas in more than one project.
   */
  listProjects(): Promise<Project[]>;
  /** Creates or renames a project — `put`, same as `save()` for documents. */
  saveProject(project: Project): Promise<void>;
  /** Removes the project. Its canvases are reassigned to Unorganized, never deleted. */
  deleteProject(id: string): Promise<void>;
  /** Moves a canvas to a project, or to Unorganized when `projectId` is undefined. */
  moveDocumentToProject(id: string, projectId: string | undefined): Promise<void>;

  /**
   * Phase 5.1 — one background image per document, stored separately from
   * the document body itself (see `document/types.ts`'s `BackgroundSettings`
   * doc comment for why). `remove(id)` deletes this row too.
   */
  saveBackgroundImage(
    documentId: string,
    blob: Blob,
    dims: { width: number; height: number },
    imageId?: string,
  ): Promise<void>;
  loadBackgroundImage(
    documentId: string,
    imageId?: string,
  ): Promise<{ blob: Blob; width: number; height: number } | null>;
  removeBackgroundImage(documentId: string, imageId?: string): Promise<void>;
  /** Deletes every stored image of the document except `keepImageId`'s (none, when `null`). */
  pruneBackgroundImages(documentId: string, keep: { imageId?: string } | null): Promise<void>;
}

export class StorageUnavailableError extends Error {
  constructor(cause?: unknown) {
    super(
      'This browser is not letting Draft Canvas store data locally. Your work is kept in memory only — export it before closing the tab.',
    );
    this.name = 'StorageUnavailableError';
    this.cause = cause;
  }
}

export class QuotaExceededError extends Error {
  constructor(cause?: unknown) {
    super(
      'This browser is out of local storage space. Delete a diagram you no longer need, or export this one to a file.',
    );
    this.name = 'QuotaExceededError';
    this.cause = cause;
  }
}

export function isQuotaError(error: unknown): boolean {
  if (error instanceof QuotaExceededError) return true;
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED';
  }
  return false;
}

export function summarize(document: DraftDocument): DraftSummary {
  return {
    id: document.metadata.id,
    title: document.metadata.title,
    createdAt: document.metadata.createdAt,
    updatedAt: document.metadata.updatedAt,
    nodeCount: document.nodes.length,
    edgeCount: document.edges.length,
    ...(document.metadata.projectId ? { projectId: document.metadata.projectId } : {}),
    ...(document.nodes.length > 0 ? { shape: libraryShapeOf(document.nodes, document.edges) } : {}),
  };
}

/**
 * The storage key of a document's background image: the document id itself for the single image
 * stored before `BackgroundSettings.imageId` existed, `<documentId>#<imageId>` for every one since.
 */
export function backgroundImageKey(documentId: string, imageId?: string): string {
  return imageId ? `${documentId}#${imageId}` : documentId;
}

/**
 * Whether `key` is one of `documentId`'s background image keys. A prefix match alone isn't enough:
 * an imported document may carry an id that itself contains `#` (`d_x#1`), and its images
 * (`d_x#1#bg_b`) must not count as `d_x`'s.
 */
export function isBackgroundImageKeyOf(key: string, documentId: string): boolean {
  if (key === documentId) return true;
  const prefix = `${documentId}#`;
  return key.startsWith(prefix) && !key.slice(prefix.length).includes('#');
}
