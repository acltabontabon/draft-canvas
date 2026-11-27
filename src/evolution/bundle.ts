/**
 * Git bundle framing: the text header in front of a pack (`git help bundle-format`).
 *
 * The only part of a bundle a Git library here doesn't write or read, so it is owned, and kept to
 * the header (ADR-1). The pack after it comes from isomorphic-git's `packObjects` or gix, and is
 * read back by `scanPack` and then the library's own indexer.
 *
 * Written: v2, SHA-1, no prerequisites, a `HEAD` line pointing where `refs/heads/main` does, so
 * `git clone history.bundle` checks out the primary architecture. Read: v2, and v3 with
 * `@object-format=sha1` only; a SHA-256 or filtered (partial) bundle is refused by name.
 */
import { HISTORY_LIMITS, HistoryError, type Oid, type RefEntry } from './contracts';
import { ALT_PREFIX, ARCHIVE_PREFIX, MAIN_REF, MILESTONE_PREFIX, isOid, isSafeId, isSafeRefName } from './refs';

export interface BundleHeader {
  version: 2 | 3;
  prerequisites: Oid[];
  refs: RefEntry[];
  /** Where `HEAD` points, when the bundle names it. */
  head: Oid | null;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function encodeBundle(refs: RefEntry[], head: Oid | null, pack: Uint8Array): Uint8Array {
  const lines = ['# v2 git bundle'];
  if (head) lines.push(`${head} HEAD`);
  for (const entry of [...refs].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))) {
    if (!isOid(entry.oid) || !isSafeRefName(entry.ref)) throw new HistoryError('invalid', 'A ref cannot be written to a bundle.');
    lines.push(`${entry.oid} ${entry.ref}`);
  }
  const header = encoder.encode(`${lines.join('\n')}\n\n`);
  const out = new Uint8Array(header.length + pack.length);
  out.set(header, 0);
  out.set(pack, header.length);
  return out;
}

/** The header, and where the pack starts. Refuses anything malformed or unsupported. */
export function parseBundle(bytes: Uint8Array): { header: BundleHeader; packStart: number } {
  if (bytes.length > HISTORY_LIMITS.maxBundleBytes) throw new HistoryError('too-large', 'That history file is larger than Draft Canvas imports.');
  // The header is text up to the first empty line; a real one is small.
  const limit = Math.min(bytes.length, 4 * 1024 * 1024);
  let end = -1;
  for (let i = 0; i + 1 < limit; i += 1) {
    if (bytes[i] === 0x0a && bytes[i + 1] === 0x0a) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new HistoryError('invalid', 'This is not a Git bundle.');
  let text: string;
  try {
    text = decoder.decode(bytes.subarray(0, end));
  } catch {
    throw new HistoryError('invalid', 'This is not a Git bundle.');
  }
  const lines = text.split('\n');
  const signature = lines.shift();
  let version: 2 | 3;
  if (signature === '# v2 git bundle') version = 2;
  else if (signature === '# v3 git bundle') version = 3;
  else throw new HistoryError('invalid', 'This is not a Git bundle Draft Canvas can read.');

  const prerequisites: Oid[] = [];
  const refs: RefEntry[] = [];
  let head: Oid | null = null;
  for (const line of lines) {
    if (line.startsWith('@')) {
      if (version !== 3) throw new HistoryError('invalid', 'This bundle’s header is malformed.');
      if (line === '@object-format=sha1') continue;
      if (line.startsWith('@object-format=')) {
        throw new HistoryError('unsupported-format', `This history uses ${line.slice('@object-format='.length)} object ids; Draft Canvas reads SHA-1 histories only.`);
      }
      if (line.startsWith('@filter=')) throw new HistoryError('unsupported-format', 'This is a partial (filtered) bundle; Draft Canvas needs the complete history.');
      throw new HistoryError('unsupported-format', 'This bundle needs a Git capability Draft Canvas does not support.');
    }
    if (line.startsWith('-')) {
      const oid = line.slice(1, 41);
      if (!isOid(oid)) throw new HistoryError('invalid', 'This bundle’s header is malformed.');
      prerequisites.push(oid);
      continue;
    }
    const space = line.indexOf(' ');
    const oid = line.slice(0, space);
    const name = line.slice(space + 1);
    if (space !== 40 || !isOid(oid)) throw new HistoryError('invalid', 'This bundle’s header is malformed.');
    if (name === 'HEAD') {
      head = oid;
      continue;
    }
    if (!isSafeRefName(name)) throw new HistoryError('invalid', 'This bundle names a ref Draft Canvas will not create.');
    refs.push({ ref: name, oid });
    if (refs.length > HISTORY_LIMITS.maxBundleRefs) throw new HistoryError('too-large', 'This bundle names too many refs.');
  }
  return { header: { version, prerequisites, refs, head }, packStart: end + 2 };
}

/** Which bundle refs an import keeps, and under what name. Anything else is reported, not created. */
export function acceptedRefs(refs: RefEntry[], head: Oid | null): { accepted: RefEntry[]; ignored: string[] } {
  const accepted: RefEntry[] = [];
  const ignored: string[] = [];
  for (const entry of refs) {
    const keep =
      entry.ref === MAIN_REF ||
      (entry.ref.startsWith(ALT_PREFIX) && isSafeId(entry.ref.slice(ALT_PREFIX.length))) ||
      (entry.ref.startsWith(ARCHIVE_PREFIX) && isSafeId(entry.ref.slice(ARCHIVE_PREFIX.length))) ||
      (entry.ref.startsWith(MILESTONE_PREFIX) && isSafeId(entry.ref.slice(MILESTONE_PREFIX.length)));
    if (keep) accepted.push(entry);
    else ignored.push(entry.ref);
  }
  // A bundle made elsewhere may call its primary branch something else: `HEAD` says which.
  if (!accepted.some((entry) => entry.ref === MAIN_REF) && head) accepted.push({ ref: MAIN_REF, oid: head });
  return { accepted, ignored };
}

