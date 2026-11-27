/**
 * DraftDocument → Structurizr DSL. Structurizr's model is strictly hierarchical — people and software
 * systems at the top, containers inside a system, components inside a container — so the document's
 * depth maps onto it directly: the top room's shapes are systems (or, when the room is a container
 * or component view, the containers or components of one system named for the canvas), and the room
 * inside a shape holds that shape's children one level down. Depth the DSL cannot express (a room
 * inside a component) is flattened into the nearest container, and says so in a comment. Boundaries
 * become `group`s. Identifiers come from `aliasFor`, unique across the workspace, since the DSL's
 * default identifier scope is flat.
 */

import { effectiveLevel, looksLikeSystemOverview } from '../../depth/level';
import type { DraftDocument, DraftNode, ViewLevel } from '../../document/types';
import {
  aliasTable,
  boundaryTree,
  collectRooms,
  edgeCaption,
  edgeTechnology,
  isArchitecture,
  isBoundary,
  nameOf,
  oneLine,
  relationshipsBetween,
  titleOf,
  type ExportRoom,
} from './shared';

const INDENT = '    ';

type Kind = 'person' | 'softwareSystem' | 'container' | 'component';

/** The DSL's identifiers may not be these; a shape that slugs to one falls back to `N7`. */
const DSL_RESERVED = new Set([
  'workspace',
  'model',
  'views',
  'person',
  'softwaresystem',
  'container',
  'component',
  'group',
  'element',
  'this',
  'properties',
  'perspectives',
  'tags',
  'url',
  'description',
  'technology',
  'systemlandscape',
  'systemcontext',
  'dynamic',
  'deployment',
  'filtered',
  'custom',
  'image',
  'styles',
  'theme',
  'themes',
  'branding',
  'terminology',
  'configuration',
  'include',
  'exclude',
  'autolayout',
  'animation',
  'title',
  'default',
  'true',
  'false',
]);

/** A DSL string: double-quoted, with the quote and the backslash escaped and the text on one line. */
function str(text: string | undefined): string {
  return `"${oneLine(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$\{/g, '$ {')}"`;
}

/** A system that is not ours: an external Service, or a system, third-party or agent Actor — as `depth/c4.ts` reads it. */
function isExternal(node: DraftNode): boolean {
  if (node.type === 'service') return node.serviceKind === 'external';
  return node.type === 'actor' && (node.actorKind === 'system' || node.actorKind === 'thirdParty' || node.actorKind === 'agent');
}

/**
 * What a shape is at a given depth of the model — people are people wherever they stand, and a system
 * outside ours is a software system at any depth (C4-PlantUML's `System_Ext`). It was declared as a
 * container of the canvas's own system, drawn inside the boundary as if we built it.
 */
function kindAt(node: DraftNode, depth: Kind): Kind {
  if (node.type === 'actor' && (node.actorKind === undefined || node.actorKind === 'human' || node.actorKind === 'group')) return 'person';
  if (isExternal(node)) return 'softwareSystem';
  if (node.type === 'actor' && depth === 'softwareSystem') return 'softwareSystem';
  return depth;
}

function tagsOf(node: DraftNode): string[] {
  const tags: string[] = [];
  if (node.type === 'database') tags.push('Database');
  if (node.type === 'queue') tags.push('Queue');
  if (node.type === 'artifact') tags.push('Artifact');
  if (isExternal(node)) tags.push('External');
  return tags;
}

/**
 * Structurizr nests one group in another only once the model declares a separator — the parser
 * refuses the workspace otherwise — and from then on reads it in any group's name as one more level.
 */
const GROUP_SEPARATOR = '/';

/** Whether a boundary sits inside another in this room, as `boundaryTree` reads `parentId`. */
function nestsGroups(room: ExportRoom): boolean {
  const boundaries = new Set(room.document.nodes.filter(isBoundary).map((node) => node.id));
  return room.document.nodes.some((node) => isBoundary(node) && node.parentId !== undefined && node.parentId !== node.id && boundaries.has(node.parentId));
}

/** `kind "Name" "Description" "Technology" "Tags"` — trailing empty arguments dropped. */
function declaration(node: DraftNode, kind: Kind): string {
  const args = [str(nameOf(node)), str(node.description)];
  if (kind === 'container' || kind === 'component') args.push(str(node.technology));
  args.push(str(tagsOf(node).join(',')));
  while (args.length > 1 && args[args.length - 1] === '""') args.pop();
  return `${kind} ${args.join(' ')}`;
}

/**
 * The depth the top room's shapes sit at, from the view's own level. A canvas that says nothing is
 * read the way `depth/level.ts` reads it: people and systems alone are a system landscape; a data
 * store or a queue in the picture means it shows how one system is built, so those are containers.
 */
function topKind(level: ViewLevel | undefined, view: DraftDocument): Kind {
  if (level === 'container') return 'container';
  if (level === 'component') return 'component';
  if (level === 'context') return 'softwareSystem';
  return looksLikeSystemOverview(view) ? 'softwareSystem' : 'container';
}

const BELOW: Record<Kind, Kind | undefined> = { person: undefined, softwareSystem: 'container', container: 'component', component: undefined };

interface Model {
  /** People and systems outside ours found inside a system or container: the DSL declares both only at model level. */
  outside: string[];
  lines: string[];
  relationships: string[];
  /** Systems with containers and containers with components — what the views section can show. */
  systems: string[];
  containers: string[];
}

export function structurizrSource(document: DraftDocument): string {
  const rooms = collectRooms(document);
  const aliases = aliasTable(rooms, DSL_RESERVED);
  const roomByOwner = new Map(rooms.filter((room) => room.owners.length > 0).map((room) => [room.owners[room.owners.length - 1]!.id, room]));
  const model: Model = { outside: [], lines: [], relationships: [], systems: [], containers: [] };
  const title = titleOf(document);
  const nests = rooms.some(nestsGroups);
  const groupName = (node: DraftNode) => {
    const name = oneLine(node.text) || 'Boundary';
    // DIVISION SLASH: drawn as a slash, never read as a level.
    return nests ? name.replaceAll(GROUP_SEPARATOR, '\u2215') : name;
  };

  const emitRoom = (room: ExportRoom, depth: Kind, at: number, out: string[]) => {
    const graph = room.document;
    const tree = boundaryTree(graph.nodes.filter((node) => isArchitecture(node) || isBoundary(node)));
    const emit = (nodes: readonly DraftNode[], level: number) => {
      for (const node of nodes) {
        if (isBoundary(node)) {
          out.push(`${INDENT.repeat(level)}group ${str(groupName(node))} {`);
          emit(tree.childrenOf(node), level + 1);
          out.push(`${INDENT.repeat(level)}}`);
          continue;
        }
        const alias = aliases.get(node.id)!;
        const kind = kindAt(node, depth);
        const inside = roomByOwner.get(node.id);
        const below = BELOW[kind];
        // A person or another system inside a system or container is declared at model level. Its
        // lines are gathered on their own and added whole, so nothing hoisted from inside its room
        // lands within its braces; relationships are model-level already.
        const hoisted = (kind === 'person' || kind === 'softwareSystem') && depth !== 'softwareSystem';
        const into = hoisted ? [] : out;
        const indent = hoisted ? 2 : level;
        if (inside && below) {
          into.push(`${INDENT.repeat(indent)}${alias} = ${declaration(node, kind)} {`);
          if (kind === 'softwareSystem') model.systems.push(alias);
          if (kind === 'container') model.containers.push(alias);
          emitRoom(inside, below, indent + 1, into);
          into.push(`${INDENT.repeat(indent)}}`);
        } else {
          into.push(`${INDENT.repeat(indent)}${alias} = ${declaration(node, kind)}`);
          if (inside) {
            // A room below a component (or a person) has no level in the DSL to live at; its shapes
            // join this one as siblings rather than vanish. A hoisted person's room still belongs at
            // the enclosing model depth.
            out.push(`${INDENT.repeat(level)}# The inside of ${str(nameOf(node))}, flattened: the DSL has no level below a ${kind}.`);
            emitRoom(inside, depth, level, out);
          }
        }
        if (hoisted) model.outside.push(...into);
      }
    };
    emit(tree.roots, at);

    const exported = new Set(graph.nodes.filter(isArchitecture).map((node) => node.id));
    for (const edge of relationshipsBetween(graph, exported)) {
      const args = [str(edgeCaption(graph, edge) || (edge.directed ? 'uses' : 'relates to'))];
      const technology = edgeTechnology(edge);
      if (technology) args.push(str(technology));
      model.relationships.push(`${INDENT.repeat(2)}${aliases.get(edge.source)!} -> ${aliases.get(edge.target)!} ${args.join(' ')}`);
    }
  };

  const top = topKind(effectiveLevel(document, rooms[0]!.path), rooms[0]!.document);
  if (top === 'softwareSystem') {
    emitRoom(rooms[0]!, 'softwareSystem', 2, model.lines);
  } else {
    // A container or component view is the inside of one system; the canvas stands for it. Its
    // people and the systems outside it are hoisted out of the wrapper by `emitRoom`, as from any nested room.
    const systemAlias = uniqueAlias('System', aliases);
    model.systems.push(systemAlias);
    const inner = top === 'component' ? uniqueAlias('Container', aliases) : undefined;
    model.lines.push(`${INDENT.repeat(2)}${systemAlias} = softwareSystem ${str(title)} {`);
    if (inner) {
      model.containers.push(inner);
      model.lines.push(`${INDENT.repeat(3)}${inner} = container ${str(title)} {`);
    }
    emitRoom(rooms[0]!, top, inner ? 4 : 3, model.lines);
    if (inner) model.lines.push(`${INDENT.repeat(3)}}`);
    model.lines.push(`${INDENT.repeat(2)}}`);
  }

  const views = [`${INDENT.repeat(2)}systemLandscape ${str('Landscape')} {`, `${INDENT.repeat(3)}include *`, `${INDENT.repeat(3)}autoLayout lr`, `${INDENT.repeat(2)}}`];
  for (const system of model.systems) {
    views.push('', `${INDENT.repeat(2)}container ${system} {`, `${INDENT.repeat(3)}include *`, `${INDENT.repeat(3)}autoLayout lr`, `${INDENT.repeat(2)}}`);
  }
  for (const container of model.containers) {
    views.push('', `${INDENT.repeat(2)}component ${container} {`, `${INDENT.repeat(3)}include *`, `${INDENT.repeat(3)}autoLayout lr`, `${INDENT.repeat(2)}}`);
  }

  const lines = [
    `# Generated by Draft Canvas from ${str(title)}`,
    `workspace ${str(title)} ${str('Exported from Draft Canvas')} {`,
    '',
    `${INDENT}model {`,
    ...(nests ? [`${INDENT.repeat(2)}properties {`, `${INDENT.repeat(3)}${str('structurizr.groupSeparator')} ${str(GROUP_SEPARATOR)}`, `${INDENT.repeat(2)}}`] : []),
    ...model.outside,
    ...model.lines,
    ...(model.relationships.length > 0 ? ['', ...model.relationships] : []),
    `${INDENT}}`,
    '',
    `${INDENT}views {`,
    ...views,
    '',
    `${INDENT.repeat(2)}theme default`,
    `${INDENT}}`,
    '}',
  ];
  return `${lines.join('\n')}\n`;
}

/** `System`, or `System2` when a shape already took the name — the wrapper is declared after the table. */
function uniqueAlias(base: string, aliases: Map<string, string>): string {
  const taken = new Set([...aliases.values()].map((alias) => alias.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n += 1) if (!taken.has(`${base}${n}`.toLowerCase())) return `${base}${n}`;
}
