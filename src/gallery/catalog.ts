/**
 * The gallery's index, `catalog.json`, read strictly: it arrives from the network, so every field is
 * checked and anything unexpected is dropped rather than trusted. The repository's own
 * `scripts/catalog.mjs` writes it; `catalog.schema.json` there documents the shape.
 */

import { GALLERY_SCHEMA, MAX_STARTER_BYTES, MAX_STARTERS } from './source';

export type GalleryCategory = 'architecture' | 'data' | 'pattern' | 'example';

/** In display order, with the header each gallery surface shows. */
export const GALLERY_CATEGORIES: readonly { id: GalleryCategory; label: string }[] = [
  { id: 'architecture', label: 'Architectures' },
  { id: 'data', label: 'Data Architectures' },
  { id: 'pattern', label: 'Patterns' },
  { id: 'example', label: 'Examples' },
];

export interface GalleryEntry {
  id: string;
  name: string;
  category: GalleryCategory;
  summary: string;
  aliases: string[];
  tags: string[];
  /** When this starter fits, and its trade-offs: a line each, shown beside its preview. */
  useWhen: string[];
  watchOutFor: string[];
  featured: boolean;
  order: number;
  path: string;
  sha256: string;
  bytes: number;
  formatVersion: number;
  /** `YYYY-MM-DD` of the file's last change. */
  updated: string;
}

export interface GalleryCatalog {
  schema: number;
  updated: string;
  starters: GalleryEntry[];
}

export type CatalogResult = { ok: true; catalog: GalleryCatalog } | { ok: false; reason: 'invalid' | 'newer' };

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PATH = /^starters\/[a-z]+\/[a-z0-9-]+\/[a-z0-9-]+\.draftcanvas$/;
const CATEGORIES = new Set<string>(GALLERY_CATEGORIES.map((c) => c.id));

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function shortText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
}

function words(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => shortText(item, 60) ?? []).slice(0, 20);
}

function lines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => shortText(item, 160) ?? []).slice(0, 4);
}

function entryOf(raw: unknown): GalleryEntry | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === 'string' && ID.test(raw.id) && raw.id.length <= 64 ? raw.id : null;
  const name = shortText(raw.name, 60);
  const summary = shortText(raw.summary, 120);
  const category = typeof raw.category === 'string' && CATEGORIES.has(raw.category) ? (raw.category as GalleryCategory) : null;
  const path = typeof raw.path === 'string' && PATH.test(raw.path) ? raw.path : null;
  const sha256 = typeof raw.sha256 === 'string' && SHA256.test(raw.sha256) ? raw.sha256 : null;
  const bytes = Number.isInteger(raw.bytes) && (raw.bytes as number) > 0 && (raw.bytes as number) <= MAX_STARTER_BYTES ? (raw.bytes as number) : null;
  const formatVersion = Number.isInteger(raw.formatVersion) && (raw.formatVersion as number) > 0 ? (raw.formatVersion as number) : null;
  if (!id || !name || !summary || !category || !path || !sha256 || !bytes || !formatVersion) return null;
  return {
    id,
    name,
    category,
    summary,
    aliases: words(raw.aliases),
    tags: words(raw.tags),
    useWhen: lines(raw.useWhen),
    watchOutFor: lines(raw.watchOutFor),
    featured: raw.featured === true,
    order: Number.isInteger(raw.order) ? (raw.order as number) : 0,
    path,
    sha256,
    bytes,
    formatVersion,
    updated: typeof raw.updated === 'string' && DATE.test(raw.updated) ? raw.updated : '',
  };
}

/** Reads `catalog.json`. Invalid entries are skipped; a catalog with none usable is invalid. */
export function parseCatalog(text: string): CatalogResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (!isRecord(raw) || !Number.isInteger(raw.schema) || !Array.isArray(raw.starters)) return { ok: false, reason: 'invalid' };
  if ((raw.schema as number) > GALLERY_SCHEMA) return { ok: false, reason: 'newer' };
  const seen = new Set<string>();
  const starters: GalleryEntry[] = [];
  for (const item of raw.starters.slice(0, MAX_STARTERS)) {
    const entry = entryOf(item);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    starters.push(entry);
  }
  if (starters.length === 0) return { ok: false, reason: 'invalid' };
  const order = GALLERY_CATEGORIES.map((c) => c.id);
  starters.sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category) || a.order - b.order || a.name.localeCompare(b.name));
  return {
    ok: true,
    catalog: { schema: raw.schema as number, updated: typeof raw.updated === 'string' && DATE.test(raw.updated) ? raw.updated : '', starters },
  };
}

/** Whether `entry` matches what someone typed: its name, aliases, tags or summary. */
export function matchesQuery(entry: GalleryEntry, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = [entry.name, entry.summary, ...entry.aliases, ...entry.tags].join(' ').toLowerCase();
  return terms.every((term) => haystack.includes(term));
}
