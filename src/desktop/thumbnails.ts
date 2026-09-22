import { useEffect, useState } from 'react';
import { libraryShapeOf } from '../document/shape';
import { deserializeDocument } from '../export/project';
import { glyphShapeOf, type StarterShape } from '../ui/Library/starterShapes';

/** What a tile draws: the diagram's own topology, nothing yet, or a blank sheet (empty, gone, unreadable). */
export type Thumbnail = { state: 'loading' } | { state: 'drawn'; shape: StarterShape } | { state: 'blank' };

const LOADING: Thumbnail = { state: 'loading' };
const BLANK: Thumbnail = { state: 'blank' };

/**
 * Drawings already made, so a file isn't read twice in a session. Keys carry the file's date, so one
 * that has changed is read again rather than drawn stale. Capped, least recently used out first: a
 * person browsing a few thousand diagrams keeps the ones they're looking at, not all of them.
 */
const cache = new Map<string, Thumbnail>();
export const CACHE_CAP = 600;

function remembered(key: string): Thumbnail | undefined {
  const known = cache.get(key);
  if (known) {
    // Map order is the recency order: touching a drawing moves it to the back.
    cache.delete(key);
    cache.set(key, known);
  }
  return known;
}

function remember(key: string, thumbnail: Thumbnail): void {
  cache.set(key, thumbnail);
  while (cache.size > CACHE_CAP) cache.delete(cache.keys().next().value!);
}

/**
 * Reads under way, so two tiles of the same file (the row and the browse view) share one — with
 * everyone waiting on it, so it's skipped only when none of them still wants it.
 */
const reading = new Map<string, { result: Promise<Thumbnail | null>; wanters: Set<() => boolean> }>();

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

/**
 * The thumbnail for `key`, from the cache or read with `load` — shared by Home's tiles and the tray.
 * `wanted` is asked again when the read's turn comes: a tile that has scrolled away or closed by then
 * isn't read at all (and resolves `null`).
 */
export async function loadThumbnail(key: string, load: () => Promise<string | null>, wanted: () => boolean = () => true): Promise<Thumbnail | null> {
  const known = remembered(key);
  if (known) return known;
  const pending = reading.get(key);
  if (pending) {
    pending.wanters.add(wanted);
    return pending.result;
  }
  const wanters = new Set([wanted]);
  const result = turn(async () => {
    if (![...wanters].some((wants) => wants())) return null;
    // `thumbnailOf` is given text from disk: whatever it makes of it, a tile shows a blank rather than a
    // read that never settles (and a rejection nothing is waiting for).
    const next = await load().then(thumbnailOf).catch(() => BLANK);
    remember(key, next);
    return next;
  }).finally(() => reading.delete(key));
  reading.set(key, { result, wanters });
  return result;
}

/**
 * The thumbnail for `key`, read with `load` once `enabled` (a tile on a closed branch, or not yet on
 * screen, isn't looked at until it is).
 */
export function useThumbnail(key: string, load: () => Promise<string | null>, enabled: boolean): Thumbnail {
  const [thumbnail, setThumbnail] = useState<Thumbnail>(() => cache.get(key) ?? LOADING);

  useEffect(() => {
    const known = remembered(key);
    if (known) {
      setThumbnail(known);
      return;
    }
    setThumbnail(LOADING);
    if (!enabled) return;
    let cancelled = false;
    void loadThumbnail(key, load, () => !cancelled).then((next) => {
      if (!cancelled && next) setThumbnail(next);
    });
    return () => {
      cancelled = true;
    };
    // `load` is a fresh closure on every render; `key` is what says the file is a different one.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);

  return thumbnail;
}
