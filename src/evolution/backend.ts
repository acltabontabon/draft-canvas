/**
 * Where histories live on this device: the browser's IndexedDB (in the history worker) or the
 * desktop app's data folder (through the desktop shell). The editor's history service is written
 * against this and `VersionStore`, and never knows which it has (ADR-1).
 */
import type { Binding, RefEntry, RepoMeta, VersionStore } from './contracts';

export interface ImportedHistory {
  repoId: string;
  refs: RefEntry[];
  /** Refs the bundle carried that Draft Canvas does not create (another tool's branches). */
  ignored: string[];
  revisions: number;
  /** The `metadata.id` of the diagram on its primary branch. */
  documentId: string;
}

export interface HistoryBackend {
  readonly kind: 'browser' | 'desktop';
  /** Every history on this device. */
  list(): Promise<RepoMeta[]>;
  create(meta: RepoMeta): Promise<VersionStore>;
  open(repoId: string): Promise<VersionStore | undefined>;
  /** Deletes a history and every revision in it. Callers confirm with the person first. */
  remove(repoId: string): Promise<void>;
  binding(copyId: string): Promise<Binding | undefined>;
  putBinding(binding: Binding): Promise<void>;
  deleteBinding(copyId: string): Promise<void>;
  bindings(): Promise<Binding[]>;
  exportBundle(repoId: string, refs: RefEntry[]): Promise<Uint8Array>;
  /** Imports a bundle as a new history described by `meta` (its `repoId` is the new one). */
  importBundle(bytes: Uint8Array, meta: RepoMeta): Promise<ImportedHistory>;
  /** Bytes this device's histories take, all together. */
  usage(): Promise<number>;
}
