/**
 * The browser's `HistoryBackend`: one bare repository per history under `/<repoId>` in the history
 * file system, and working-copy bindings in a small state store. Runs in the history worker.
 */
import type { HistoryBackend, ImportedHistory } from '../backend';
import { HistoryError, type Binding, type RefEntry, type RepoMeta, type VersionStore } from '../contracts';
import type { LockRunner } from '../locks';
import { isSafeId } from '../refs';
import { readHistoryText } from '../snapshot';
import { exportBundle, importBundle } from './bundleIo';
import { IgitStore } from './igitStore';
import type { KvFs } from './kvfs';

/** Small JSON records beside the repositories. */
export interface StateStore {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<{ key: string; value: unknown }[]>;
}

export class MemoryState implements StateStore {
  private readonly values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
  async list(prefix: string): Promise<{ key: string; value: unknown }[]> {
    return [...this.values].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, value]) => ({ key, value }));
  }
}

const BINDING = 'binding:';

function isBinding(value: unknown): value is Binding {
  const b = value as Partial<Binding> | null;
  return !!b && typeof b.copyId === 'string' && typeof b.repoId === 'string' && isSafeId(b.repoId) && (b.altId === null || (typeof b.altId === 'string' && isSafeId(b.altId)));
}

export class BrowserBackend implements HistoryBackend {
  readonly kind = 'browser' as const;
  private readonly stores = new Map<string, IgitStore>();

  private readonly fs: KvFs;
  private readonly state: StateStore;
  private readonly lock: LockRunner;

  constructor(fs: KvFs, state: StateStore, lock: LockRunner) {
    this.fs = fs;
    this.state = state;
    this.lock = lock;
  }

  async list(): Promise<RepoMeta[]> {
    const out: RepoMeta[] = [];
    for (const name of (await this.fs.readdir('/')).sort()) {
      if (!isSafeId(name)) continue;
      const store = await this.open(name);
      if (!store) continue;
      try {
        out.push(await store.meta());
      } catch {
        // A history whose repo.json cannot be read is skipped, not deleted: a person may want it.
      }
    }
    return out;
  }

  async create(meta: RepoMeta): Promise<VersionStore> {
    const store = await IgitStore.create(this.fs, meta, this.lock);
    this.stores.set(meta.repoId, store);
    return store;
  }

  async open(repoId: string): Promise<IgitStore | undefined> {
    if (!isSafeId(repoId)) return undefined;
    const known = this.stores.get(repoId);
    if (known) return known;
    const store = await IgitStore.open(this.fs, repoId, this.lock);
    if (store) this.stores.set(repoId, store);
    return store;
  }

  async remove(repoId: string): Promise<void> {
    if (!isSafeId(repoId)) throw new HistoryError('invalid', 'Not a history id.');
    this.stores.delete(repoId);
    await this.fs.removeTree(`/${repoId}`);
    for (const binding of await this.bindings()) {
      if (binding.repoId === repoId) await this.deleteBinding(binding.copyId);
    }
  }

  async binding(copyId: string): Promise<Binding | undefined> {
    const value = await this.state.get<unknown>(`${BINDING}${copyId}`);
    return isBinding(value) ? value : undefined;
  }

  async putBinding(binding: Binding): Promise<void> {
    if (!isBinding(binding)) throw new HistoryError('invalid', 'Not a working-copy binding.');
    await this.state.put(`${BINDING}${binding.copyId}`, binding);
  }

  async deleteBinding(copyId: string): Promise<void> {
    await this.state.delete(`${BINDING}${copyId}`);
  }

  async bindings(): Promise<Binding[]> {
    return (await this.state.list(BINDING)).map((entry) => entry.value).filter(isBinding);
  }

  async exportBundle(repoId: string, refs: RefEntry[]): Promise<Uint8Array> {
    const store = await this.open(repoId);
    if (!store) throw new HistoryError('not-found', 'That history is not on this device.');
    return exportBundle(store, refs);
  }

  async importBundle(bytes: Uint8Array, meta: RepoMeta): Promise<ImportedHistory> {
    let documentId = '';
    const result = await importBundle(this.fs, this.lock, bytes, meta, (text) => {
      documentId ||= readHistoryText(text).document.metadata.id;
    });
    this.stores.set(meta.repoId, result.store);
    // The primary branch's newest revision names the diagram.
    const main = result.refs.find((entry) => entry.ref === 'refs/heads/main');
    if (main) documentId = readHistoryText(await result.store.readSnapshot(main.oid)).document.metadata.id;
    await result.store.writeMeta({ ...meta, documentId });
    return { repoId: meta.repoId, refs: result.refs, ignored: result.ignored, revisions: result.revisions, documentId };
  }

  async usage(): Promise<number> {
    return (await this.fs.usage('/')).bytes;
  }
}
