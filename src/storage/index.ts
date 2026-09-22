import { hostKind } from '../host/hostInfo';
import { IndexedDbRepository } from './IndexedDbRepository';
import { MemoryRepository } from './MemoryRepository';
import type { DraftRepository } from './DraftRepository';

let cached: Promise<DraftRepository> | null = null;

/**
 * Returns the best available local store, falling back to memory rather than
 * failing. The caller can check `repository.durable` to warn the user.
 *
 * With a host (VS Code, or the desktop app), the host's file is the store, so memory only holds the
 * open document and the browser's own library is never opened.
 */
export function getRepository(): Promise<DraftRepository> {
  if (hostKind()) return (cached ??= Promise.resolve(new MemoryRepository()));
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
