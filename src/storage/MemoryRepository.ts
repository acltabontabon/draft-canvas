import { backgroundImageKey, isBackgroundImageKeyOf, summarize, type DraftRepository } from './DraftRepository';
import type { DraftDocument, DraftSummary, Project } from '../document/types';

/**
 * Non-durable fallback. Used when IndexedDB cannot be opened, and by tests.
 * The UI degrades honestly: the save indicator says "In memory only".
 */
export class MemoryRepository implements DraftRepository {
  readonly kind = 'memory' as const;
  readonly durable = false;

  private readonly documents = new Map<string, DraftDocument>();
  private readonly backgroundImages = new Map<
    string,
    { blob: Blob; width: number; height: number }
  >();
  private readonly projects = new Map<string, Project>();

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
    for (const key of [...this.backgroundImages.keys()]) {
      if (isBackgroundImageKeyOf(key, id)) this.backgroundImages.delete(key);
    }
  }

  async rename(id: string, title: string): Promise<void> {
    const found = this.documents.get(id);
    if (!found) return;
    found.metadata = { ...found.metadata, title, updatedAt: Date.now() };
  }

  async listProjects(): Promise<Project[]> {
    return [...this.projects.values()];
  }

  async saveProject(project: Project): Promise<void> {
    this.projects.set(project.id, { ...project });
  }

  async deleteProject(id: string): Promise<void> {
    for (const document of this.documents.values()) {
      if (document.metadata.projectId === id) {
        const metadata = { ...document.metadata, updatedAt: Date.now() };
        delete metadata.projectId;
        document.metadata = metadata;
      }
    }
    this.projects.delete(id);
  }

  async moveDocumentToProject(id: string, projectId: string | undefined): Promise<void> {
    const found = this.documents.get(id);
    if (!found) return;
    const metadata = { ...found.metadata, updatedAt: Date.now() };
    if (projectId) metadata.projectId = projectId;
    else delete metadata.projectId;
    found.metadata = metadata;
  }

  async usage(): Promise<{ usage: number; quota: number } | null> {
    return null;
  }

  async saveBackgroundImage(
    documentId: string,
    blob: Blob,
    dims: { width: number; height: number },
    imageId?: string,
  ): Promise<void> {
    this.backgroundImages.set(backgroundImageKey(documentId, imageId), { blob, ...dims });
  }

  async loadBackgroundImage(
    documentId: string,
    imageId?: string,
  ): Promise<{ blob: Blob; width: number; height: number } | null> {
    return this.backgroundImages.get(backgroundImageKey(documentId, imageId)) ?? null;
  }

  async removeBackgroundImage(documentId: string, imageId?: string): Promise<void> {
    this.backgroundImages.delete(backgroundImageKey(documentId, imageId));
  }

  async pruneBackgroundImages(documentId: string, keep: { imageId?: string } | null): Promise<void> {
    const kept = keep ? backgroundImageKey(documentId, keep.imageId) : null;
    for (const key of [...this.backgroundImages.keys()]) {
      if (isBackgroundImageKeyOf(key, documentId) && key !== kept) this.backgroundImages.delete(key);
    }
  }
}
