/**
 * Refreshing the gallery and reading it back. A refresh reads `catalog.json`, then only the starter
 * files whose SHA-256 the cache doesn't already hold. Each file must hash to what the catalog says
 * and open as a Draft Canvas document before it is kept, and a failed refresh leaves the last good
 * copy exactly as it was.
 */

import { libraryShapeOf } from '../document/shape';
import { parseDocument } from '../document/validate';
import { CURRENT_VERSION, type DraftDocument, type LibraryShape } from '../document/types';
import { parseCatalog, type GalleryCatalog, type GalleryEntry } from './catalog';
import { cachedFileKeys, pruneFiles, readCachedGallery, readFile, readSeen, writeCachedGallery, writeFile, writeSeen } from './cache';
import { GalleryRequestError, readGalleryFile } from './remote';
import { MAX_CATALOG_BYTES, MAX_STARTER_BYTES } from './source';

/** Why a starter can't be added: it needs a newer Draft Canvas, or its file didn't arrive. */
export type GalleryAvailability = 'ready' | 'needs-update' | 'missing';
/** A starter added since the person last looked, or changed since. */
export type GalleryMark = 'new' | 'updated';

export interface GalleryStarter extends GalleryEntry {
  availability: GalleryAvailability;
  mark?: GalleryMark;
  /** Its topology, for the tile's drawing; absent until the file has arrived. */
  shape?: LibraryShape;
}

export interface GallerySnapshot {
  starters: GalleryStarter[];
  fetchedAt: number;
}

export type RefreshFailure = 'offline' | 'newer' | 'invalid';

export class GalleryRefreshError extends Error {
  readonly reason: RefreshFailure;

  constructor(reason: RefreshFailure) {
    super(`Starters gallery refresh failed: ${reason}`);
    this.reason = reason;
    this.name = 'GalleryRefreshError';
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Drawn once per file: a starter's shape changes only when its file does. */
const shapes = new Map<string, LibraryShape | null>();

async function shapeOf(sha256: string): Promise<LibraryShape | undefined> {
  if (!shapes.has(sha256)) {
    const text = await readFile(sha256);
    const parsed = text ? parseDocument(text) : null;
    shapes.set(sha256, parsed?.ok ? libraryShapeOf(parsed.document.nodes, parsed.document.edges) : null);
  }
  return shapes.get(sha256) ?? undefined;
}

async function marked(catalog: GalleryCatalog, available: ReadonlySet<string>, seen: Record<string, string>): Promise<GalleryStarter[]> {
  // Before anything was ever seen, nothing is "new": the whole gallery is.
  const first = Object.keys(seen).length === 0;
  return Promise.all(catalog.starters.map(async (entry) => {
    const availability: GalleryAvailability = entry.formatVersion > CURRENT_VERSION ? 'needs-update' : available.has(entry.sha256) ? 'ready' : 'missing';
    const before = seen[entry.id];
    const mark: GalleryMark | undefined = first ? undefined : before === undefined ? 'new' : before !== entry.sha256 ? 'updated' : undefined;
    const shape = availability === 'ready' ? await shapeOf(entry.sha256) : undefined;
    return { ...entry, availability, ...(mark ? { mark } : {}), ...(shape ? { shape } : {}) };
  }));
}

/** The gallery as last downloaded, or `null` if it never was. Never touches the network. */
export async function loadGallery(): Promise<GallerySnapshot | null> {
  const cached = await readCachedGallery();
  if (!cached) return null;
  const [files, seen] = await Promise.all([cachedFileKeys(), readSeen()]);
  return { starters: await marked(cached.catalog, files, seen), fetchedAt: cached.fetchedAt };
}

/** Reads the catalog and any changed starters from GitHub, keeps them, and returns the result. */
export async function refreshGallery(): Promise<GallerySnapshot> {
  let text: string;
  try {
    text = await readGalleryFile('catalog.json', MAX_CATALOG_BYTES);
  } catch (error) {
    throw new GalleryRefreshError(error instanceof GalleryRequestError && error.reason === 'too-large' ? 'invalid' : 'offline');
  }
  const parsed = parseCatalog(text);
  if (!parsed.ok) throw new GalleryRefreshError(parsed.reason);
  const { catalog } = parsed;

  const held = await cachedFileKeys();
  const wanted = catalog.starters.filter((entry) => entry.formatVersion <= CURRENT_VERSION && !held.has(entry.sha256));
  // A few at a time: the catalog is small, and GitHub serves each file from its CDN.
  const queue = [...wanted];
  const worker = async () => {
    for (let entry = queue.shift(); entry; entry = queue.shift()) {
      try {
        const body = await readGalleryFile(entry.path, Math.min(MAX_STARTER_BYTES, entry.bytes + 1024));
        if ((await sha256Hex(body)) !== entry.sha256) continue;
        if (!parseDocument(body).ok) continue;
        await writeFile(entry.sha256, body);
        held.add(entry.sha256);
      } catch {
        // This one stays "missing"; the rest still arrive.
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);

  const fetchedAt = Date.now();
  await writeCachedGallery({ catalog, fetchedAt });
  await pruneFiles(new Set(catalog.starters.map((entry) => entry.sha256)));
  let seen = await readSeen();
  if (Object.keys(seen).length === 0) {
    // The first load sees everything as it is: later changes are what get marked.
    seen = Object.fromEntries(catalog.starters.map((entry) => [entry.id, entry.sha256]));
    await writeSeen(seen);
    return { starters: await marked(catalog, held, {}), fetchedAt };
  }
  return { starters: await marked(catalog, held, seen), fetchedAt };
}

/** Records that the person has looked at this version of a starter, clearing its mark. */
export async function markStarterSeen(entry: Pick<GalleryEntry, 'id' | 'sha256'>): Promise<void> {
  const seen = await readSeen();
  if (seen[entry.id] === entry.sha256) return;
  await writeSeen({ ...seen, [entry.id]: entry.sha256 });
}

/** A downloaded starter's diagram, read and checked again from the cache. */
export async function starterFile(entry: Pick<GalleryEntry, 'sha256'>): Promise<DraftDocument | null> {
  const text = await readFile(entry.sha256);
  if (!text) return null;
  const parsed = parseDocument(text);
  return parsed.ok ? parsed.document : null;
}
