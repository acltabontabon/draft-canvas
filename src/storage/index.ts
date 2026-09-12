import { IndexedDbRepository } from './IndexedDbRepository';
import { MemoryRepository } from './MemoryRepository';
import type { DraftRepository } from './DraftRepository';

let cached: Promise<DraftRepository> | null = null;

/**
 * Returns the best available local store, falling back to memory rather than
 * failing. The caller can check `repository.durable` to warn the user.
 */
export function getRepository(): Promise<DraftRepository> {
  cached ??= IndexedDbRepository.open().catch((error) => {
    console.warn('[draft-canvas] Falling back to in-memory storage.', error);
    return new MemoryRepository();
  });
  return cached;
}

/** Test seam. */
export function __setRepository(repository: DraftRepository | null): void {
  cached = repository ? Promise.resolve(repository) : null;
}

export * from './DraftRepository';
