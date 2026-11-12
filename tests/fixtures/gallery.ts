import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { libraryShapeOf } from '../../src/document/shape';
import type { DraftDocument } from '../../src/document/types';
import { parseDocument } from '../../src/document/validate';
import { parseCatalog, type GalleryCatalog, type GalleryEntry } from '../../src/gallery/catalog';
import { writeCachedGallery, writeFile } from '../../src/gallery/cache';
import type { GallerySnapshot } from '../../src/gallery/sync';
import { useGalleryStore } from '../../src/store/galleryStore';
import type { AgentStarter } from '../../src/agent/starter';

/**
 * The vendored starters gallery (`tests/fixtures/starters/`, refreshed by `npm run starters:fixtures`)
 * as the app would hold it after loading: what tests use instead of reaching GitHub.
 */

const ROOT = join(__dirname, 'starters');

/** `catalog.json` exactly as the repository serves it. */
export function vendoredCatalogText(): string {
  return readFileSync(join(ROOT, 'catalog.json'), 'utf8');
}

export function vendoredCatalog(): GalleryCatalog {
  const parsed = parseCatalog(vendoredCatalogText());
  if (!parsed.ok) throw new Error(`The vendored catalog does not parse: ${parsed.reason}`);
  return parsed.catalog;
}

export function vendoredText(entry: Pick<GalleryEntry, 'path'>): string {
  return readFileSync(join(ROOT, entry.path), 'utf8');
}

export function vendoredFile(id: string): DraftDocument {
  const entry = vendoredCatalog().starters.find((s) => s.id === id);
  if (!entry) throw new Error(`No starter "${id}" in the vendored gallery.`);
  const parsed = parseDocument(vendoredText(entry));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.document;
}

export function vendoredSnapshot(): GallerySnapshot {
  const catalog = vendoredCatalog();
  return {
    fetchedAt: Date.now(),
    starters: catalog.starters.map((entry) => {
      const parsed = parseDocument(vendoredText(entry));
      const shape = parsed.ok ? libraryShapeOf(parsed.document.nodes, parsed.document.edges) : undefined;
      return { ...entry, availability: 'ready' as const, ...(shape ? { shape } : {}) };
    }),
  };
}

/** The store holding the vendored gallery, loaded, with its files in the (fake) IndexedDB cache. */
export async function seedGallery(): Promise<GallerySnapshot> {
  const catalog = vendoredCatalog();
  for (const entry of catalog.starters) await writeFile(entry.sha256, vendoredText(entry));
  await writeCachedGallery({ catalog, fetchedAt: Date.now() });
  const snapshot = vendoredSnapshot();
  useGalleryStore.setState({ enabled: true, snapshot, failure: null, status: 'idle', dialog: { open: false } });
  return snapshot;
}

/** A vendored starter as the page hands it to the agent (`desktop/agent.ts`). */
export function agentStarter(id: string): AgentStarter {
  const entry = vendoredCatalog().starters.find((s) => s.id === id);
  if (!entry) throw new Error(`No starter "${id}" in the vendored gallery.`);
  return { id: entry.id, name: entry.name, category: entry.category, summary: entry.summary, file: vendoredFile(id) };
}

/** Every vendored starter, as `get_capabilities` receives them. */
export function agentStarters(): AgentStarter[] {
  return vendoredCatalog().starters.map((s) => agentStarter(s.id));
}

/** The starter a `create_diagram` request names, resolved the way the page resolves it. */
export function starterOf(raw: unknown): { starter?: AgentStarter } {
  const id = (raw as { starter?: { id?: unknown } } | null)?.starter?.id;
  return typeof id === 'string' && vendoredCatalog().starters.some((s) => s.id === id) ? { starter: agentStarter(id) } : {};
}
