import { summarize, type DraftRepository } from './DraftRepository';
import type { DraftDocument, DraftSummary } from '../document/types';

/**
 * Non-durable fallback. Used when IndexedDB cannot be opened, and by tests.
 * The UI degrades honestly: the save indicator says "In memory only".
 */
export class MemoryRepository implements DraftRepository {
  readonly kind = 'memory' as const;
  readonly durable = false;

  private readonly documents = new Map<string, DraftDocument>();

  async list(): Promise<DraftSummary[]> {
    return [...this.documents.values()]
      .map(summarize)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async load(id: string): Promise<DraftDocument | null> {
    const found = this.documents.get(id);
    return found ? structuredClone(found) : null;
  }

  async save(document: DraftDocument): Promise<void> {
    this.documents.set(document.metadata.id, structuredClone(document));
  }

  async remove(id: string): Promise<void> {
    this.documents.delete(id);
  }

  async rename(id: string, title: string): Promise<void> {
    const found = this.documents.get(id);
    if (!found) return;
    found.metadata = { ...found.metadata, title, updatedAt: Date.now() };
  }

  async usage(): Promise<{ usage: number; quota: number } | null> {
    return null;
  }
}
