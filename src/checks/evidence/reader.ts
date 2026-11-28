/**
 * How a check reads a repository: through this, and nothing else.
 *
 * The checks never touch a file system. Whoever runs them hands over a reader bound to one folder
 * the person chose (the CLI's `--repo`, a project folder on the desktop), and the reader is where
 * the limits live: nothing outside the folder, nothing through a link that leads out of it, no file
 * past the size cap, no listing without an end. A reader answers with a status rather than
 * throwing, so "could not read" is something a check can report instead of something that stops it.
 *
 * Repository content is data. Nothing read through a reader is ever executed, followed as an
 * instruction, or copied into a finding: findings carry locations, never contents.
 */

export type ReadResult =
  | { status: 'ok'; text: string }
  /** Nothing is at that path. */
  | { status: 'missing' }
  /** Something is there, but it is not read: over the size cap, not text, a link or a path that
   *  leaves the folder, or an error from the file system. */
  | { status: 'too-large' | 'binary' | 'outside' | 'unreadable'; detail?: string };

export interface RepoListing {
  /** Regular files, relative to the folder, forward slashes, sorted. */
  paths: string[];
  /** The listing stopped at a limit: a file not in it may still exist. */
  truncated: boolean;
}

export interface RepoReader {
  list(): Promise<RepoListing>;
  read(path: string): Promise<ReadResult>;
}

export interface RepoLimits {
  maxFiles: number;
  maxDepth: number;
  maxFileBytes: number;
  maxReads: number;
}

export const REPO_LIMITS: RepoLimits = {
  /** Files listed before a listing says it is incomplete. */
  maxFiles: 50_000,
  /** Folders deep. */
  maxDepth: 24,
  /** Bytes read from one file. */
  maxFileBytes: 2 * 1024 * 1024,
  /** Files read in one check. */
  maxReads: 5_000,
};

/**
 * A repository-relative path as the checks compare them: forward slashes, no `./`, no empty or
 * dot segments. `null` for anything absolute or leading out of the folder. A reader still has to
 * check what the path resolves to; this only keeps two spellings of one path from differing.
 */
export function normalizeRepoPath(path: string): string | null {
  const text = path.trim().replace(/\\/g, '/');
  if (!text || text.startsWith('/') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(text)) return null;
  const parts: string[] = [];
  for (const part of text.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') return null;
    parts.push(part);
  }
  return parts.length ? parts.join('/') : null;
}

/** A reader over files held in memory: for tests, and for a caller that already has the content. */
export function memoryReader(files: Readonly<Record<string, string>>, options: { truncated?: boolean } = {}): RepoReader {
  const known = new Map<string, string>();
  for (const [path, text] of Object.entries(files)) {
    const normal = normalizeRepoPath(path);
    if (normal) known.set(normal, text);
  }
  return {
    list: async () => ({ paths: [...known.keys()].sort(), truncated: options.truncated ?? false }),
    read: async (path) => {
      const normal = normalizeRepoPath(path);
      if (!normal) return { status: 'outside' };
      const text = known.get(normal);
      if (text === undefined) return { status: 'missing' };
      if (text.length > REPO_LIMITS.maxFileBytes) return { status: 'too-large' };
      return { status: 'ok', text };
    },
  };
}
