/**
 * Canvas Evolution on the desktop: the `HistoryBackend` over the shell's history commands, and the
 * working-copy identity of whatever the controller has open.
 *
 * Histories live in the app's own data folder, never beside the diagrams: a project folder that is
 * a Git repository gets nothing written into it by recording history (ADR-4).
 */
import type { HistoryBackend, ImportedHistory } from '../evolution/backend';
import { acceptedRefs, encodeBundle, parseBundle } from '../evolution/bundle';
import { HistoryError, type Binding, type Oid, type RefEntry, type RepoMeta, type VersionStore } from '../evolution/contracts';
import type { CopyKey } from '../evolution/identity';
import { verifyImported } from '../evolution/importCheck';
import { PackRejected, scanPack } from '../evolution/packScan';
import { MAIN_REF, MILESTONE_PREFIX } from '../evolution/refs';
import { readHistoryText } from '../evolution/snapshot';
import { installHistoryBackend } from '../store/evolution/bridge';
import type { DesktopApi } from './api';
import {
  createHistory,
  deleteBinding,
  exportPack,
  getBinding,
  importAbort,
  importBegin,
  importCommit,
  listBindings,
  listHistories,
  openHistory,
  putBinding,
  removeHistory,
} from './historyStore';

const PACK_LIMITS = { maxObjects: 2_000_000, maxObjectBytes: 24 * 1024 * 1024, maxTotalInflated: 2 * 1024 * 1024 * 1024, maxDeltaDepth: 4096 };

export class DesktopHistoryBackend implements HistoryBackend {
  readonly kind = 'desktop' as const;
  private readonly api: DesktopApi;

  constructor(api: DesktopApi) {
    this.api = api;
  }

  list(): Promise<RepoMeta[]> {
    return listHistories(this.api);
  }
  create(meta: RepoMeta): Promise<VersionStore> {
    return createHistory(this.api, meta);
  }
  open(repoId: string): Promise<VersionStore | undefined> {
    return openHistory(this.api, repoId);
  }
  remove(repoId: string): Promise<void> {
    return removeHistory(this.api, repoId);
  }
  binding(copyId: string): Promise<Binding | undefined> {
    return getBinding(this.api, copyId);
  }
  putBinding(binding: Binding): Promise<void> {
    return putBinding(this.api, binding);
  }
  deleteBinding(copyId: string): Promise<void> {
    return deleteBinding(this.api, copyId);
  }
  bindings(): Promise<Binding[]> {
    return listBindings(this.api);
  }

  async exportBundle(repoId: string, refs: RefEntry[]): Promise<Uint8Array> {
    const pack = await exportPack(this.api, repoId, refs.map((entry) => entry.oid));
    return encodeBundle(refs, refs.find((entry) => entry.ref === MAIN_REF)?.oid ?? null, pack);
  }

  /**
   * Scanned here within limits, indexed by the shell into a staging repository nothing is bound to,
   * checked revision by revision, and only then given its refs. Anything wrong removes the staging
   * repository whole.
   *
   * The shell reads a tag only through its ref, and the staging repository has none, so looking a
   * milestone up there refused every bundle that had one, the desktop's own exports included.
   * Milestones are checked right after the commit gives them refs instead, while the new history is
   * still bound to nothing and its documentId unset, and anything wrong removes it whole.
   */
  async importBundle(bytes: Uint8Array, meta: RepoMeta): Promise<ImportedHistory> {
    const { header, packStart } = parseBundle(bytes);
    if (header.prerequisites.length > 0) throw new HistoryError('unsupported-format', 'This is an incremental bundle: it needs earlier history this device does not have.');
    const { accepted, ignored } = acceptedRefs(header.refs, header.head);
    const main = accepted.find((entry) => entry.ref === MAIN_REF);
    if (!main) throw new HistoryError('invalid', 'This bundle has no primary branch to import.');
    const pack = bytes.subarray(packStart);
    try {
      scanPack(pack, PACK_LIMITS);
    } catch (error) {
      if (error instanceof PackRejected) throw new HistoryError('corrupt', error.message);
      throw error;
    }
    const validate = (text: string) => void readHistoryText(text);
    const checked = new Set<Oid>();
    const staging = await importBegin(this.api, meta, pack);
    let store: VersionStore;
    let documentId: string;
    try {
      await verifyImported(
        staging,
        accepted.filter((entry) => !entry.ref.startsWith(MILESTONE_PREFIX)),
        validate,
        checked,
      );
      documentId = readHistoryText(await staging.readSnapshot(main.oid)).document.metadata.id;
      store = await importCommit(this.api, staging, accepted);
    } catch (error) {
      await importAbort(this.api, staging).catch(() => undefined);
      throw error;
    }
    try {
      await verifyImported(
        store,
        accepted.filter((entry) => entry.ref.startsWith(MILESTONE_PREFIX)),
        validate,
        checked,
      );
      await store.writeMeta({ ...(await store.meta()), documentId });
      return { repoId: store.repoId, refs: accepted, ignored, revisions: checked.size, documentId };
    } catch (error) {
      await removeHistory(this.api, store.repoId).catch(() => undefined);
      throw error;
    }
  }

  async usage(): Promise<number> {
    let total = 0;
    for (const meta of await this.list()) {
      const store = await this.open(meta.repoId);
      if (store) total += (await store.usage()).bytes;
    }
    return total;
  }
}

/**
 * Installs the desktop backend before any document opens. `copyKey` says which working copy the
 * controller has open: a saved file by its path, a Quick Draft or unsaved canvas by its recovery
 * entry — so history follows the file, not the `metadata.id` inside it (ADR-2).
 */
export function installDesktopHistory(api: DesktopApi, copyKey: () => CopyKey | null): void {
  const backend = new DesktopHistoryBackend(api);
  installHistoryBackend(() => backend, copyKey);
}
