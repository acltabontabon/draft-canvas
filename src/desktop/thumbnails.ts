import { useEffect, useState } from 'react';
import { libraryShapeOf } from '../document/shape';
import { deserializeDocument } from '../export/project';
import { glyphShapeOf, type StarterShape } from '../ui/Library/starterShapes';

/** What a tile draws: the diagram's own topology, nothing yet, or a blank sheet (empty, gone, unreadable). */
export type Thumbnail = { state: 'loading' } | { state: 'drawn'; shape: StarterShape } | { state: 'blank' };

const LOADING: Thumbnail = { state: 'loading' };
const BLANK: Thumbnail = { state: 'blank' };

/** Home is small; this is just to not read the same file twice in a session. Keys carry the file's
 *  date, so a file that has changed since is read again rather than drawn stale. */
const cache = new Map<string, Thumbnail>();

/** A handful of small reads at a time: a project's shelf asks for a dozen at once. */
const CONCURRENT = 3;
let running = 0;
const waiting: (() => void)[] = [];

async function turn<T>(work: () => Promise<T>): Promise<T> {
  if (running >= CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
  running += 1;
  try {
    return await work();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

/**
 * A diagram's text as the tile glyph a starter would get. Parsed by the same validator every open
 * goes through, then reduced to a silhouette (kinds and boxes, never words) — the text itself is
 * not kept.
 */
export function thumbnailOf(text: string | null): Thumbnail {
  if (!text) return BLANK;
  const parsed = deserializeDocument(text);
  if (!parsed.ok) return BLANK;
  const shape = libraryShapeOf(parsed.document.nodes, parsed.document.edges);
  return shape.nodes.length > 0 ? { state: 'drawn', shape: glyphShapeOf(shape) } : BLANK;
}

/** The thumbnail for `key`, from the cache or read with `load` — shared by Home's tiles and the tray. */
export async function loadThumbnail(key: string, load: () => Promise<string | null>): Promise<Thumbnail> {
  const known = cache.get(key);
  if (known) return known;
  const next = await turn(load).then(thumbnailOf, () => BLANK);
  cache.set(key, next);
  return next;
}

/**
 * The thumbnail for `key`, read with `load` once `enabled` (a tile on a closed branch isn't looked
 * at until its branch opens).
 */
export function useThumbnail(key: string, load: () => Promise<string | null>, enabled: boolean): Thumbnail {
  const [thumbnail, setThumbnail] = useState<Thumbnail>(() => cache.get(key) ?? LOADING);

  useEffect(() => {
    const known = cache.get(key);
    if (known) {
      setThumbnail(known);
      return;
    }
    setThumbnail(LOADING);
    if (!enabled) return;
    let cancelled = false;
    void loadThumbnail(key, load).then((next) => {
      if (!cancelled) setThumbnail(next);
    });
    return () => {
      cancelled = true;
    };
    // `load` is a fresh closure on every render; `key` is what says the file is a different one.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);

  return thumbnail;
}
