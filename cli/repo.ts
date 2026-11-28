/**
 * The repository reader the CLI hands to the checks: one folder, read and never written, with the
 * limits a check on an untrusted checkout needs.
 *
 * - Nothing outside the folder is read. A path is resolved through every link before it is opened
 *   and refused unless the result is still inside.
 * - Links are never followed while listing, so a link back up the tree can't make the listing loop
 *   or wander off.
 * - A listing stops at `maxFiles` and `maxDepth` and says it stopped. A file past `maxFileBytes`,
 *   or one that is not text, is reported and not read.
 * - No command is run and nothing is fetched: this module uses the file system and nothing else.
 */

import { lstatSync, openSync, closeSync, readSync, fstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { normalizeRepoPath, REPO_LIMITS, type ReadResult, type RepoLimits, type RepoListing, type RepoReader } from '../src/checks/evidence/reader';

/** Folders that hold nothing a diagram cites and can be very large. */
const SKIPPED = new Set(['.git', '.hg', '.svn', 'node_modules']);

export class RepoError extends Error {}

export function fileSystemReader(folder: string, limits: RepoLimits = REPO_LIMITS): RepoReader {
  let root: string;
  try {
    root = realpathSync(resolve(folder));
    if (!statSync(root).isDirectory()) throw new RepoError(`${folder} is not a folder.`);
  } catch (error) {
    if (error instanceof RepoError) throw error;
    throw new RepoError(`${folder} could not be opened as a folder.`);
  }
  const inside = (absolute: string) => absolute === root || absolute.startsWith(root + sep);

  let listing: RepoListing | undefined;
  const list = (): RepoListing => {
    if (listing) return listing;
    const paths: string[] = [];
    let truncated = false;
    const pending: { dir: string; relative: string; depth: number }[] = [{ dir: root, relative: '', depth: 0 }];
    while (pending.length > 0 && !truncated) {
      const { dir, relative, depth } = pending.pop()!;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        // A folder that can't be read makes the listing incomplete, which the checks must know.
        truncated = true;
        break;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        const path = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (SKIPPED.has(entry.name)) continue;
          if (depth + 1 > limits.maxDepth) truncated = true;
          else pending.push({ dir: join(dir, entry.name), relative: path, depth: depth + 1 });
        } else if (entry.isFile()) {
          if (paths.length >= limits.maxFiles) {
            truncated = true;
            break;
          }
          paths.push(path);
        }
      }
    }
    paths.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    listing = { paths, truncated };
    return listing;
  };

  const read = (path: string): ReadResult => {
    const normal = normalizeRepoPath(path);
    if (!normal) return { status: 'outside' };
    const wanted = join(root, ...normal.split('/'));
    let real: string;
    try {
      lstatSync(wanted);
      real = realpathSync(wanted);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === 'ENOENT' || code === 'ENOTDIR' ? { status: 'missing' } : { status: 'unreadable', detail: code };
    }
    if (!inside(real)) return { status: 'outside' };
    let handle: number | undefined;
    try {
      handle = openSync(real, 'r');
      const info = fstatSync(handle);
      if (!info.isFile()) return { status: 'unreadable', detail: 'not a file' };
      if (info.size > limits.maxFileBytes) return { status: 'too-large' };
      const bytes = Buffer.alloc(info.size);
      let got = 0;
      while (got < bytes.length) {
        const n = readSync(handle, bytes, got, bytes.length - got, got);
        if (n === 0) break;
        got += n;
      }
      const content = bytes.subarray(0, got);
      if (content.subarray(0, 8192).includes(0)) return { status: 'binary' };
      return { status: 'ok', text: content.toString('utf8') };
    } catch (error) {
      return { status: 'unreadable', detail: (error as NodeJS.ErrnoException).code };
    } finally {
      if (handle !== undefined) closeSync(handle);
    }
  };

  return { list: async () => list(), read: async (path) => read(path) };
}
