import type { SimpleIcon } from 'simple-icons';
import { dataStoreGlyphBounds } from '../document/dataStoreGeometry';
import { C4_TEXT_TYPES, type DraftNode } from '../document/types';
import catalog from './technologyCatalog/index.json';
import { TECHNOLOGY_PATH_LOADERS } from './technologyCatalog/loaders';

export type TechnologyIcon = Pick<SimpleIcon, 'title' | 'slug' | 'path'>;
export type TechnologyIconSnapshot = ReadonlyMap<string, TechnologyIcon>;
export const TECHNOLOGY_ICON_COUNT = catalog.icons.length;

/** A neutral chip, drawn locally rather than borrowing a brand for an unknown technology. */
export const GENERIC_TECHNOLOGY_ICON: TechnologyIcon = {
  title: 'Custom technology',
  slug: 'generic-technology',
  path: 'M5 4h14v16H5z M7 6v12h10V6z M10 9h4v6h-4z M8 1h2v3H8z M14 1h2v3h-2z M8 20h2v3H8z M14 20h2v3h-2z M2 8h3v2H2z M2 14h3v2H2z M19 8h3v2h-3z M19 14h3v2h-3z',
};

const VERSION_SUFFIX = /\s+v?\d+(?:\.\d+)*(?:\.x)?$/i;
const cleanName = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');
const normalizedName = (value: string) => {
  const name = cleanName(value);
  // Brand names such as PlayStation 5 contain digits of their own, not a version suffix.
  return NAMES.has(name) ? name : name.replace(VERSION_SUFFIX, '');
};

// Names and slugs are small enough to search immediately. Artwork stays in separate local chunks.
const CATALOG = (catalog.icons as [string, string][]).map(([title, slug]): TechnologyIcon => ({ title, slug, path: GENERIC_TECHNOLOGY_ICON.path }));
let bySlug = new Map(CATALOG.map((icon) => [icon.slug, icon]));
/** Contexts retain a stable view of the artwork, so describing the same context stays pure. */
export function technologyIconSnapshot(): TechnologyIconSnapshot { return bySlug; }
const TITLE_COUNTS = new Map<string, number>();
for (const icon of CATALOG) TITLE_COUNTS.set(cleanName(icon.title), (TITLE_COUNTS.get(cleanName(icon.title)) ?? 0) + 1);
// Upstream includes unrelated brands with the same title. Keep both selectable and persist the
// disambiguator as ordinary technology text, rather than silently substituting the other logo.
const displayName = (icon: TechnologyIcon) => TITLE_COUNTS.get(cleanName(icon.title))! > 1 ? `${icon.title} (${icon.slug})` : icon.title;
const ALIASES: readonly (readonly [string, string])[] = [
  ['postgres', 'postgresql'],
  ['mongo', 'mongodb'],
  ['nodejs', 'nodedotjs'],
  ['node', 'nodedotjs'],
  ['js', 'javascript'],
  ['ts', 'typescript'],
  ['golang', 'go'],
  ['cpp', 'cplusplus'],
  ['c plus plus', 'cplusplus'],
  ['dotnet', 'dotnet'],
  ['springboot', 'springboot'],
  ['rabbit mq', 'rabbitmq'],
  ['kafka', 'apachekafka'],
  ['react.js', 'react'],
  ['reactjs', 'react'],
  ['vue', 'vuedotjs'],
  ['vuejs', 'vuedotjs'],
  ['k8s', 'kubernetes'],
  ['nextjs', 'nextdotjs'],
  ['next', 'nextdotjs'],
  ['nuxt.js', 'nuxt'],
  ['nuxtjs', 'nuxt'],
  ['nest.js', 'nestjs'],
  ['nest', 'nestjs'],
  ['fast api', 'fastapi'],
  ['rails', 'rubyonrails'],
  ['elastic search', 'elasticsearch'],
  ['open search', 'opensearch'],
  ['traefik', 'traefikproxy'],
  ['envoy', 'envoyproxy'],
  ['otel', 'opentelemetry'],
  ['gcp', 'googlecloud'],
  ['google cloud platform', 'googlecloud'],
];
const NAMES = new Map(ALIASES);
for (const icon of CATALOG) {
  if (!NAMES.has(cleanName(icon.title))) NAMES.set(cleanName(icon.title), icon.slug);
  NAMES.set(cleanName(displayName(icon)), icon.slug);
}
for (const icon of CATALOG) NAMES.set(icon.slug, icon.slug);
// Preserve the familiar first matches without restricting which brands can be found.
const COMMON = new Set(['postgresql', 'mongodb', 'nodedotjs', 'python', 'springboot', 'dotnet', 'react', 'rust']);
const loaded = new Set<string>();
const pending = new Map<string, Promise<void>>();
const listeners = new Map<string, Set<() => void>>();

export function technologyIcon(technology: string | undefined, snapshot: TechnologyIconSnapshot = bySlug): TechnologyIcon | undefined {
  if (!technology?.trim()) return undefined;
  const slug = NAMES.get(normalizedName(technology));
  return (slug ? snapshot.get(slug) : undefined) ?? GENERIC_TECHNOLOGY_ICON;
}

/** Unknown/custom technologies need no asset. Imports are deduplicated and failures can be retried. */
export async function loadTechnologyIcon(technology: string | undefined): Promise<TechnologyIcon | undefined> {
  const icon = technologyIcon(technology);
  if (!icon || icon === GENERIC_TECHNOLOGY_ICON || loaded.has(icon.slug)) return icon;
  const group = icon.slug[0]!;
  let request = pending.get(group);
  if (!request) {
    const loader = TECHNOLOGY_PATH_LOADERS[group];
    if (!loader) throw new Error('Technology icon asset is missing.');
    request = loader().then(({ default: paths }) => {
      const next = new Map(bySlug);
      for (const [slug, path] of Object.entries(paths)) {
        const entry = bySlug.get(slug);
        if (!entry || !path) continue;
        next.set(slug, { ...entry, path });
        loaded.add(slug);
      }
      bySlug = next;
      for (const slug of Object.keys(paths)) for (const listener of listeners.get(slug) ?? []) listener();
    }).finally(() => { pending.delete(group); });
    pending.set(group, request);
  }
  await request;
  if (!loaded.has(icon.slug)) throw new Error('Technology icon asset is incomplete.');
  return bySlug.get(icon.slug);
}

export function subscribeTechnologyIcon(technology: string | undefined, listener: () => void): () => void {
  const icon = technologyIcon(technology);
  if (!icon || icon === GENERIC_TECHNOLOGY_ICON) return () => {};
  let subscribers = listeners.get(icon.slug);
  if (!subscribers) { subscribers = new Set(); listeners.set(icon.slug, subscribers); }
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
    if (!subscribers.size) listeners.delete(icon.slug);
  };
}

/** Preflight asynchronous image exports so even a never-opened room uses its real logos. */
export async function loadTechnologyIcons(nodes: readonly DraftNode[]): Promise<void> {
  const values = new Set(nodes.filter((node) => (C4_TEXT_TYPES as readonly string[]).includes(node.type)).map((node) => node.technology));
  await Promise.all([...values].map(loadTechnologyIcon));
}

/** Exact names/slugs and known aliases are recognized; mixed stacks never borrow a single logo. */
export function technologySuggestions(value: string): { value: string; icon: TechnologyIcon }[] {
  const query = normalizedName(value);
  const version = NAMES.has(cleanName(value)) ? '' : value.trim().match(VERSION_SUFFIX)?.[0] ?? '';
  const matches = new Map<string, number>();
  for (const [name, slug] of NAMES) {
    if (!name.includes(query)) continue;
    const rank = name === query ? 0 : name.startsWith(query) ? 1 : 2;
    matches.set(slug, Math.min(rank, matches.get(slug) ?? Infinity));
  }
  return CATALOG.filter((icon) => matches.has(icon.slug))
    .sort((a, b) => matches.get(a.slug)! - matches.get(b.slug)! || Number(COMMON.has(b.slug)) - Number(COMMON.has(a.slug)))
    .slice(0, 6)
    .map((icon) => ({ value: displayName(icon) + version, icon: bySlug.get(icon.slug)! }));
}

export function nodeTechnologyIcon(node: DraftNode, snapshot: TechnologyIconSnapshot = bySlug): TechnologyIcon | undefined {
  return (C4_TEXT_TYPES as readonly string[]).includes(node.type) ? technologyIcon(node.technology, snapshot) : undefined;
}

export const TECHNOLOGY_MARK_SIZE = 16;

/** Node-local visual extent only. The mark never changes sizing, handles or routing obstacles.
 * Data stores attach to their compact glyph; other architecture shapes use their box's corner. */
export function technologyMarkBounds(node: DraftNode, snapshot: TechnologyIconSnapshot = bySlug): { x: number; y: number; width: number; height: number } | undefined {
  if (!nodeTechnologyIcon(node, snapshot)) return undefined;
  const glyph = node.type === 'database'
    ? dataStoreGlyphBounds({ ...node, x: 0, y: 0 })
    : { right: node.width, top: 0 };
  return { x: glyph.right + 9, y: glyph.top + 2, width: TECHNOLOGY_MARK_SIZE, height: TECHNOLOGY_MARK_SIZE };
}
