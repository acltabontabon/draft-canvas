import {
  siApachekafka,
  siDocker,
  siDotnet,
  siGo,
  siKubernetes,
  siMariadb,
  siMongodb,
  siMysql,
  siNginx,
  siNodedotjs,
  siPostgresql,
  siPython,
  siRabbitmq,
  siReact,
  siRedis,
  siSpringboot,
  siSqlite,
  siTypescript,
  type SimpleIcon,
} from 'simple-icons';
import { dataStoreGlyphBounds } from '../document/dataStoreGeometry';
import { C4_TEXT_TYPES, type DraftNode } from '../document/types';

/** A deliberately small bundled catalog. Never guess a brand from a substring or mixed stack. */
const ICONS: ReadonlyMap<string, SimpleIcon> = new Map([
  ['postgresql', siPostgresql], ['postgres', siPostgresql],
  ['mysql', siMysql], ['mariadb', siMariadb], ['mongodb', siMongodb], ['mongo', siMongodb],
  ['redis', siRedis], ['sqlite', siSqlite],
  ['node.js', siNodedotjs], ['nodejs', siNodedotjs], ['node', siNodedotjs],
  ['python', siPython], ['spring boot', siSpringboot], ['springboot', siSpringboot],
  ['.net', siDotnet], ['dotnet', siDotnet],
  ['rabbitmq', siRabbitmq], ['rabbit mq', siRabbitmq],
  ['apache kafka', siApachekafka], ['kafka', siApachekafka],
  ['react', siReact], ['react.js', siReact], ['reactjs', siReact],
  ['nginx', siNginx], ['docker', siDocker], ['kubernetes', siKubernetes], ['k8s', siKubernetes],
  ['go', siGo], ['golang', siGo], ['typescript', siTypescript],
]);

export type TechnologyIcon = Pick<SimpleIcon, 'title' | 'slug' | 'path'>;

/** A neutral chip, drawn locally rather than borrowing a brand for an unknown technology. */
export const GENERIC_TECHNOLOGY_ICON: TechnologyIcon = {
  title: 'Custom technology',
  slug: 'generic-technology',
  path: 'M5 4h14v16H5z M7 6v12h10V6z M10 9h4v6h-4z M8 1h2v3H8z M14 1h2v3h-2z M8 20h2v3H8z M14 20h2v3h-2z M2 8h3v2H2z M2 14h3v2H2z M19 8h3v2h-3z M19 14h3v2h-3z',
};

const CATALOG = [...new Set(ICONS.values())];
const VERSION_SUFFIX = /\s+v?\d+(?:\.\d+)*(?:\.x)?$/i;
const normalizedName = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ').replace(VERSION_SUFFIX, '');

export function technologyIcon(technology: string | undefined): TechnologyIcon | undefined {
  if (!technology?.trim()) return undefined;
  return ICONS.get(normalizedName(technology)) ?? GENERIC_TECHNOLOGY_ICON;
}

/** Only branded matches become suggestions. Free text always remains a valid value, and a
 * version the user already typed survives choosing the matching canonical name. */
export function technologySuggestions(value: string): { value: string; icon: TechnologyIcon }[] {
  const query = normalizedName(value);
  const version = value.trim().match(VERSION_SUFFIX)?.[0] ?? '';
  const matches = new Set([...ICONS].filter(([alias]) => alias.includes(query)).map(([, icon]) => icon));
  return CATALOG.filter((icon) => matches.has(icon))
    .sort((a, b) => Number(b.title.toLowerCase().startsWith(query)) - Number(a.title.toLowerCase().startsWith(query)))
    .slice(0, 6)
    .map((icon) => ({ value: icon.title + version, icon }));
}

export function nodeTechnologyIcon(node: DraftNode): TechnologyIcon | undefined {
  return (C4_TEXT_TYPES as readonly string[]).includes(node.type) ? technologyIcon(node.technology) : undefined;
}

export const TECHNOLOGY_MARK_SIZE = 16;

/** Node-local visual extent only. The mark never changes sizing, handles or routing obstacles.
 * Data stores attach to their compact glyph; other architecture shapes use their box's corner. */
export function technologyMarkBounds(node: DraftNode): { x: number; y: number; width: number; height: number } | undefined {
  if (!nodeTechnologyIcon(node)) return undefined;
  const glyph = node.type === 'database'
    ? dataStoreGlyphBounds({ ...node, x: 0, y: 0 })
    : { right: node.width, top: 0 };
  return { x: glyph.right + 9, y: glyph.top + 2, width: TECHNOLOGY_MARK_SIZE, height: TECHNOLOGY_MARK_SIZE };
}
