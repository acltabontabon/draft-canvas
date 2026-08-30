import type { DraftDocument, DraftSummary } from '../document/types';

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
  };
}
