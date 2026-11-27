/**
 * The file system isomorphic-git asks for, over a key-value store of whole files.
 *
 * Owned here rather than taken from LightningFS on purpose (ADR-1): LightningFS keeps a superblock
 * in memory and flushes it on a debounce, so a closed tab can lose a write it already reported done.
 * Here each `writeFile` is one store transaction that has committed before the promise resolves —
 * Git's own ordering (objects before the ref that names them) then holds across a crash.
 *
 * Only what a bare repository needs: files and directories, no links, no permissions. Paths are
 * absolute, `/`-separated and normalized here; nothing outside the store is ever touched.
 */

export type Entry = { kind: 'file'; data: Uint8Array; mtimeMs: number } | { kind: 'dir'; mtimeMs: number };

export interface KvStore {
  get(path: string): Promise<Entry | undefined>;
  put(path: string, entry: Entry): Promise<void>;
  delete(path: string): Promise<void>;
  /** Every key strictly under `prefix/`, in key order. */
  keysUnder(prefix: string): Promise<string[]>;
}

function fsError(code: 'ENOENT' | 'EEXIST' | 'ENOTDIR' | 'ENOTEMPTY' | 'EISDIR' | 'EINVAL', path: string): Error & { code: string } {
  const error = new Error(`${code}: ${path}`) as Error & { code: string };
  error.code = code;
  return error;
}

export function normalizePath(path: string): string {
  if (typeof path !== 'string' || !path.startsWith('/')) throw fsError('EINVAL', String(path));
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') throw fsError('EINVAL', path);
    parts.push(part);
  }
  return `/${parts.join('/')}`;
}

function parentOf(path: string): string {
  const at = path.lastIndexOf('/');
  return at <= 0 ? '/' : path.slice(0, at);
}

class Stats {
  readonly mode: number;
  readonly size: number;
  readonly ino = 0;
  readonly uid = 1;
  readonly gid = 1;
  readonly dev = 1;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly type: 'file' | 'dir';
  constructor(entry: Entry) {
    this.type = entry.kind;
    this.mode = entry.kind === 'dir' ? 0o40755 : 0o100644;
    this.size = entry.kind === 'file' ? entry.data.byteLength : 0;
    this.mtimeMs = entry.mtimeMs;
    this.ctimeMs = entry.mtimeMs;
  }
  isFile(): boolean {
    return this.type === 'file';
  }
  isDirectory(): boolean {
    return this.type === 'dir';
  }
  isSymbolicLink(): boolean {
    return false;
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A `fs.promises`-shaped client for isomorphic-git. */
export class KvFs {
  readonly promises = this;

  private readonly store: KvStore;
  private readonly now: () => number;

  constructor(store: KvStore, now: () => number = () => Date.now()) {
    this.store = store;
    this.now = now;
  }

  private async entry(path: string): Promise<Entry | undefined> {
    return path === '/' ? { kind: 'dir', mtimeMs: 0 } : this.store.get(path);
  }

  async readFile(raw: string, options?: { encoding?: string } | string): Promise<Uint8Array | string> {
    const path = normalizePath(raw);
    const entry = await this.entry(path);
    if (!entry) throw fsError('ENOENT', path);
    if (entry.kind === 'dir') throw fsError('EISDIR', path);
    const encoding = typeof options === 'string' ? options : options?.encoding;
    return encoding === 'utf8' ? decoder.decode(entry.data) : entry.data;
  }

  async writeFile(raw: string, data: Uint8Array | string): Promise<void> {
    const path = normalizePath(raw);
    const parent = await this.entry(parentOf(path));
    if (!parent) throw fsError('ENOENT', path);
    if (parent.kind !== 'dir') throw fsError('ENOTDIR', path);
    const existing = await this.store.get(path);
    if (existing?.kind === 'dir') throw fsError('EISDIR', path);
    const bytes = typeof data === 'string' ? encoder.encode(data) : new Uint8Array(data);
    await this.store.put(path, { kind: 'file', data: bytes, mtimeMs: this.now() });
  }

  async unlink(raw: string): Promise<void> {
    const path = normalizePath(raw);
    const entry = await this.store.get(path);
    if (!entry) throw fsError('ENOENT', path);
    if (entry.kind === 'dir') throw fsError('EISDIR', path);
    await this.store.delete(path);
  }

  async readdir(raw: string): Promise<string[]> {
    const path = normalizePath(raw);
    const entry = await this.entry(path);
    if (!entry) throw fsError('ENOENT', path);
    if (entry.kind !== 'dir') throw fsError('ENOTDIR', path);
    const prefix = path === '/' ? '' : path;
    const names = new Set<string>();
    for (const key of await this.store.keysUnder(prefix)) {
      const rest = key.slice(prefix.length + 1);
      if (rest.length > 0 && !rest.includes('/')) names.add(rest);
    }
    return [...names];
  }

  async mkdir(raw: string): Promise<void> {
    const path = normalizePath(raw);
    if (path === '/') throw fsError('EEXIST', path);
    if (await this.store.get(path)) throw fsError('EEXIST', path);
    const parent = await this.entry(parentOf(path));
    if (!parent) throw fsError('ENOENT', path);
    if (parent.kind !== 'dir') throw fsError('ENOTDIR', path);
    await this.store.put(path, { kind: 'dir', mtimeMs: this.now() });
  }

  async rmdir(raw: string): Promise<void> {
    const path = normalizePath(raw);
    const entry = await this.store.get(path);
    if (!entry) throw fsError('ENOENT', path);
    if (entry.kind !== 'dir') throw fsError('ENOTDIR', path);
    if ((await this.store.keysUnder(path)).length > 0) throw fsError('ENOTEMPTY', path);
    await this.store.delete(path);
  }

  async stat(raw: string): Promise<Stats> {
    const path = normalizePath(raw);
    const entry = await this.entry(path);
    if (!entry) throw fsError('ENOENT', path);
    return new Stats(entry);
  }

  lstat(raw: string): Promise<Stats> {
    return this.stat(raw);
  }

  async readlink(raw: string): Promise<never> {
    throw fsError('EINVAL', raw);
  }

  async symlink(_target: string, raw: string): Promise<never> {
    // A history repository never holds a link: refusing keeps one from ever pointing anywhere.
    throw fsError('EINVAL', raw);
  }

  /** Creates `path` and every missing parent. */
  async mkdirp(raw: string): Promise<void> {
    const path = normalizePath(raw);
    if (path === '/') return;
    const existing = await this.store.get(path);
    if (existing?.kind === 'dir') return;
    if (existing) throw fsError('ENOTDIR', path);
    await this.mkdirp(parentOf(path));
    await this.store.put(path, { kind: 'dir', mtimeMs: this.now() });
  }

  /** Removes `path` and everything under it. */
  async removeTree(raw: string): Promise<void> {
    const path = normalizePath(raw);
    const keys = await this.store.keysUnder(path === '/' ? '' : path);
    for (const key of keys.reverse()) await this.store.delete(key);
    if (await this.store.get(path)) await this.store.delete(path);
  }

  /** Total bytes and file count under `path`. */
  async usage(raw: string): Promise<{ bytes: number; files: number }> {
    const path = normalizePath(raw);
    let bytes = 0;
    let files = 0;
    for (const key of await this.store.keysUnder(path === '/' ? '' : path)) {
      const entry = await this.store.get(key);
      if (entry?.kind === 'file') {
        bytes += entry.data.byteLength;
        files += 1;
      }
    }
    return { bytes, files };
  }
}

/** An in-memory store: the tests' backend, and the fallback when IndexedDB is unavailable. */
export class MemoryKv implements KvStore {
  private readonly entries = new Map<string, Entry>();

  async get(path: string): Promise<Entry | undefined> {
    return this.entries.get(path);
  }
  async put(path: string, entry: Entry): Promise<void> {
    this.entries.set(path, entry);
  }
  async delete(path: string): Promise<void> {
    this.entries.delete(path);
  }
  async keysUnder(prefix: string): Promise<string[]> {
    const start = `${prefix}/`;
    return [...this.entries.keys()].filter((key) => key.startsWith(start)).sort();
  }
}
