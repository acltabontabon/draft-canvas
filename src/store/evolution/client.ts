/**
 * The editor's side of the history worker: requests out, answers back, and nothing else.
 *
 * One worker for the life of the page. If it fails to load or dies, every waiting request is
 * refused with `unavailable` and the next request starts a new worker, at most `MAX_RESTARTS`
 * times — history then reports itself unavailable, and drawing and autosave carry on regardless.
 * Where workers are unavailable (tests, some embedded views) the same dispatcher runs on the page.
 *
 * Requests are bounded: at most `MAX_PENDING` wait at once; beyond that the oldest kind of work —
 * a capture — is the caller's to coalesce (the scheduler only ever runs one), so a refusal here
 * means something is wrong, not busy.
 */
import type { HistoryBackend, ImportedHistory } from '../../evolution/backend';
import { HistoryError, type Binding, type RefEntry, type RepoMeta, type VersionStore } from '../../evolution/contracts';
import { hasWebLocks, processLocks, webLocks } from '../../evolution/locks';
import type { ComputeMethod, Request, SerializedError, compute as Compute } from '../../evolution/workerHost';

const MAX_PENDING = 64;
const MAX_RESTARTS = 3;

type Reply = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: SerializedError };

interface Channel {
  send(request: Request, transfer?: Transferable[]): Promise<unknown>;
}

function toError(error: SerializedError): HistoryError {
  return new HistoryError(error.code === 'internal' ? 'unavailable' : error.code, error.message);
}

class WorkerChannel implements Channel {
  private worker: Worker | null = null;
  private restarts = 0;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();

  private readonly storage: boolean;

  constructor(storage: boolean) {
    this.storage = storage;
  }

  private start(): Worker {
    if (this.worker) return this.worker;
    if (this.restarts > MAX_RESTARTS) throw new HistoryError('unavailable', 'History stopped working on this page. Reload to try again.');
    const worker = new Worker(new URL('../../evolution/worker.ts', import.meta.url), { type: 'module', name: 'draft-canvas-history' });
    worker.onmessage = (event: MessageEvent<Reply>) => {
      const waiting = this.pending.get(event.data.id);
      if (!waiting) return;
      this.pending.delete(event.data.id);
      if (event.data.ok) waiting.resolve(event.data.value);
      else waiting.reject(toError(event.data.error));
    };
    worker.onerror = (event) => {
      event.preventDefault();
      this.fail();
    };
    worker.postMessage({ setup: { storage: this.storage } });
    this.worker = worker;
    return worker;
  }

  private fail(): void {
    this.worker?.terminate();
    this.worker = null;
    this.restarts += 1;
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const { reject } of waiting) reject(new HistoryError('unavailable', 'History stopped while working. It will try again.'));
  }

  send(request: Request, transfer: Transferable[] = []): Promise<unknown> {
    if (this.pending.size >= MAX_PENDING) return Promise.reject(new HistoryError('unavailable', 'History is behind; it will catch up.'));
    let worker: Worker;
    try {
      worker = this.start();
    } catch (error) {
      return Promise.reject(error);
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        worker.postMessage({ id, request }, transfer);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }
}

/** The dispatcher on the page itself, for tests and pages without workers. */
class InlineChannel implements Channel {
  private readonly backend: Promise<HistoryBackend | undefined>;

  constructor(backend: Promise<HistoryBackend | undefined>) {
    this.backend = backend;
  }
  async send(request: Request): Promise<unknown> {
    const { handle } = await import('../../evolution/workerHost');
    try {
      // Structured clone on the way in and out, as a worker would: nothing shared by reference.
      return structuredClone(await handle(structuredClone(request), await this.backend));
    } catch (error) {
      if (error instanceof HistoryError) throw error;
      throw new HistoryError('unavailable', 'History could not complete that.');
    }
  }
}

export type ComputeApi = { [K in ComputeMethod]: (...args: Parameters<(typeof Compute)[K]>) => ReturnType<(typeof Compute)[K]> };

function computeApi(channel: Channel): ComputeApi {
  const call = (method: ComputeMethod) => (...args: unknown[]) => channel.send({ family: 'compute', method, args });
  return {
    prepare: call('prepare'),
    parse: call('parse'),
    diff: call('diff'),
    describe: call('describe'),
  } as ComputeApi;
}

class RemoteStore implements VersionStore {
  private readonly channel: Channel;
  readonly repoId: string;

  constructor(channel: Channel, repoId: string) {
    this.channel = channel;
    this.repoId = repoId;
  }
  private call<T>(method: keyof VersionStore, ...args: unknown[]): Promise<T> {
    return this.channel.send({ family: 'store', repoId: this.repoId, method, args }) as Promise<T>;
  }
  meta = () => this.call<RepoMeta>('meta');
  writeMeta = (meta: RepoMeta) => this.call<void>('writeMeta', meta);
  writeSnapshot: VersionStore['writeSnapshot'] = (write) => this.call('writeSnapshot', write);
  updateRef: VersionStore['updateRef'] = (update) => this.call('updateRef', update);
  readRef: VersionStore['readRef'] = (ref) => this.call('readRef', ref);
  listRefs: VersionStore['listRefs'] = (prefix) => this.call('listRefs', prefix);
  readCommit: VersionStore['readCommit'] = (oid) => this.call('readCommit', oid);
  readSnapshot: VersionStore['readSnapshot'] = (oid) => this.call('readSnapshot', oid);
  log: VersionStore['log'] = (query) => this.call('log', query);
  mergeBases: VersionStore['mergeBases'] = (a, b) => this.call('mergeBases', a, b);
  isAncestor: VersionStore['isAncestor'] = (a, d) => this.call('isAncestor', a, d);
  writeTag: VersionStore['writeTag'] = (tag) => this.call('writeTag', tag);
  listTags: VersionStore['listTags'] = (prefix) => this.call('listTags', prefix);
  journalPut: VersionStore['journalPut'] = (record) => this.call('journalPut', record);
  journalList: VersionStore['journalList'] = () => this.call('journalList');
  journalDelete: VersionStore['journalDelete'] = (opId) => this.call('journalDelete', opId);
  usage: VersionStore['usage'] = () => this.call('usage');
  maintain: VersionStore['maintain'] = () => this.call('maintain');
}

class RemoteBackend implements HistoryBackend {
  readonly kind = 'browser' as const;
  private readonly channel: Channel;

  constructor(channel: Channel) {
    this.channel = channel;
  }
  private call<T>(method: keyof HistoryBackend, args: unknown[], transfer?: Transferable[]): Promise<T> {
    return this.channel.send({ family: 'backend', method, args }, transfer) as Promise<T>;
  }
  list = () => this.call<RepoMeta[]>('list', []);
  async create(meta: RepoMeta): Promise<VersionStore> {
    await this.call('create', [meta]);
    return new RemoteStore(this.channel, meta.repoId);
  }
  async open(repoId: string): Promise<VersionStore | undefined> {
    const known = (await this.list()).some((meta) => meta.repoId === repoId);
    return known ? new RemoteStore(this.channel, repoId) : undefined;
  }
  remove = (repoId: string) => this.call<void>('remove', [repoId]);
  binding = (copyId: string) => this.call<Binding | undefined>('binding', [copyId]);
  putBinding = (binding: Binding) => this.call<void>('putBinding', [binding]);
  deleteBinding = (copyId: string) => this.call<void>('deleteBinding', [copyId]);
  bindings = () => this.call<Binding[]>('bindings', []);
  exportBundle = (repoId: string, refs: RefEntry[]) => this.call<Uint8Array>('exportBundle', [repoId, refs]);
  importBundle = (bytes: Uint8Array, meta: RepoMeta) => this.call<ImportedHistory>('importBundle', [bytes, meta]);
  usage = () => this.call<number>('usage', []);
}

let channel: Channel | undefined;
/** Whether the worker keeps histories (web) or only computes (desktop, where the shell keeps them). */
let workerStorage = true;

function makeChannel(storage: boolean): Channel {
  if (typeof Worker !== 'undefined') return new WorkerChannel(storage);
  const backend = storage
    ? Promise.all([import('../../evolution/browser/backend'), import('../../evolution/browser/historyDb'), import('../../evolution/browser/kvfs')]).then(
        ([{ BrowserBackend }, db, { KvFs }]) =>
          new BrowserBackend(new KvFs(new db.IdbKv()), { get: db.readState, put: db.writeState, delete: db.deleteState, list: db.listState }, hasWebLocks() ? webLocks : processLocks()),
      )
    : Promise.resolve(undefined);
  return new InlineChannel(backend);
}

/** Called once by a shell that keeps histories itself (desktop), before any history work. */
export function historyWorkerComputesOnly(): void {
  if (channel) return;
  workerStorage = false;
}

/** Pure history work, off the drawing thread. One worker serves both this and the web's storage. */
export function historyCompute(): ComputeApi {
  channel ??= makeChannel(workerStorage);
  return computeApi(channel);
}

/** The browser's histories, in IndexedDB through the worker. */
export function browserHistoryBackend(): HistoryBackend {
  if (!workerStorage) throw new HistoryError('unavailable', 'Histories are kept by the desktop app here.');
  channel ??= makeChannel(true);
  return new RemoteBackend(channel);
}

/** Test seam: forget the channels so a test starts from nothing. */
export function __resetHistoryChannels(): void {
  channel = undefined;
  workerStorage = true;
}
