/**
 * DraftDocument → C4-PlantUML text. The C4 role of each shape is `depth/c4.ts`'s reading of the
 * document (person, software system, container, component), never a guess made here; where it
 * says `unspecified`, the shape's own kind decides which macro draws it, because a `.puml` has to
 * name something. Each room is a `Container_Boundary` named for the shape it is inside; a
 * boundary on the canvas is a `System_Boundary` when its preset says system, a plain `Boundary`
 * otherwise. Text is escaped exactly as `sequence/plantuml.ts` does, with PlantUML's own
 * `<U+XXXX>` codes.
 */

import { classify, type C4Role } from '../../depth/c4';
import { effectiveLevel } from '../../depth/level';
import type { DraftDocument, DraftEdge, DraftNode } from '../../document/types';
import {
  aliasTable,
  boundaryTree,
  collectRooms,
  edgeCaption,
  edgesBetween,
  edgeTechnology,
  isArchitecture,
  isBoundary,
  nameOf,
  oneLine,
  titleOf,
  type ExportRoom,
} from './shared';

const INDENT = '    ';

/**
 * PlantUML reads markup inside text — Creole, a subset of HTML, `%` preprocessor calls, `\n` — and
 * the C4 macros add `$` variables to the list. Every opener is written as PlantUML's own `<U+XXXX>`
 * code, which renders as exactly that character and starts nothing; the quote is the one character
 * the quoted macro argument itself cares about.
 */
function escapeText(text: string): string {
  return oneLine(text)
    .replace(/<|%|~|\\|\$|\*\*|--|__/g, (token) => (token.length === 2 ? `${unicodeCode(token)}${token[1]}` : unicodeCode(token)))
    .replace(/"/g, '<U+0022>');
}

function unicodeCode(text: string): string {
  return `<U+${text.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}>`;
}

const quote = (text: string | undefined): string => `"${escapeText(text ?? '')}"`;

/** The macro that draws a shape, from its C4 role when the document settles one, else its kind. */
function macroFor(node: DraftNode, role: C4Role, external: boolean): string {
  const ext = external ? '_Ext' : '';
  switch (role) {
    case 'person':
      return `Person${ext}`;
    case 'software-system':
      return `System${ext}`;
    case 'container':
      return node.type === 'database' ? `ContainerDb${ext}` : node.type === 'queue' ? `ContainerQueue${ext}` : `Container${ext}`;
    case 'component':
      return node.type === 'database' ? `ComponentDb${ext}` : node.type === 'queue' ? `ComponentQueue${ext}` : `Component${ext}`;
    default:
      switch (node.type) {
        case 'actor':
          return node.actorKind === 'system' || node.actorKind === 'thirdParty' ? 'System_Ext' : `Person${ext}`;
        case 'database':
          return `ContainerDb${ext}`;
        case 'queue':
          return `ContainerQueue${ext}`;
        case 'component':
          return `Component${ext}`;
        default:
          return node.serviceKind === 'external' ? 'System_Ext' : `Container${ext}`;
      }
  }
}

/** `Person`/`System` take (alias, label, description); the rest take a technology argument too. */
function elementLine(node: DraftNode, alias: string, macro: string, depth: number): string {
  const args = [alias, quote(nameOf(node))];
  const technology = oneLine(node.technology);
  const description = oneLine(node.description);
  if (macro.startsWith('Person') || macro.startsWith('System')) {
    if (description || technology) args.push(quote(description || technology));
  } else {
    if (technology || description) args.push(quote(technology));
    if (description) args.push(quote(description));
  }
  return `${INDENT.repeat(depth)}${macro}(${args.join(', ')})`;
}

function renderRoom(
  file: DraftDocument,
  room: ExportRoom,
  aliases: Map<string, string>,
  depth: number,
  usesComponents: { value: boolean },
): string[] {
  const graph = room.document;
  const level = effectiveLevel(file, room.path);
  const owner = room.owners[room.owners.length - 1];
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const tree = boundaryTree(graph.nodes.filter((node) => isArchitecture(node) || isBoundary(node)));
  const lines: string[] = [];

  const emit = (nodes: readonly DraftNode[], at: number) => {
    for (const node of nodes) {
      const alias = aliases.get(node.id)!;
      if (isBoundary(node)) {
        const macro = node.boundaryPreset === 'system' ? 'System_Boundary' : 'Boundary';
        const args = [alias, quote(oneLine(node.text) || 'Boundary')];
        if (macro === 'Boundary') args.push(quote(node.boundaryPreset ?? 'boundary'));
        lines.push(`${INDENT.repeat(at)}${macro}(${args.join(', ')}) {`);
        emit(tree.childrenOf(node), at + 1);
        lines.push(`${INDENT.repeat(at)}}`);
        continue;
      }
      const systemBoundary = node.parentId ? byId.get(node.parentId) : undefined;
      const c4 = classify(node, {
        level,
        insideOwner: owner,
        systemBoundary: systemBoundary?.type === 'group' && systemBoundary.boundaryPreset === 'system' ? systemBoundary : undefined,
      });
      const macro = macroFor(node, c4?.role ?? 'unspecified', c4?.scope === 'external');
      if (macro.startsWith('Component')) usesComponents.value = true;
      lines.push(elementLine(node, alias, macro, at));
    }
  };
  emit(tree.roots, depth);

  const exported = new Set(graph.nodes.filter(isArchitecture).map((node) => node.id));
  const edges = edgesBetween(graph, exported);
  if (edges.length > 0 && lines.length > 0) lines.push('');
  for (const edge of edges) lines.push(`${INDENT.repeat(depth)}${relLine(graph, edge, aliases)}`);
  return lines;
}

/** `Rel(a, b, "label", "technology")`; `BiRel` for a connector with no direction. */
function relLine(graph: DraftDocument, edge: DraftEdge, aliases: Map<string, string>): string {
  const args = [aliases.get(edge.source)!, aliases.get(edge.target)!, quote(edgeCaption(graph, edge) || (edge.directed ? 'uses' : 'relates to'))];
  const technology = edgeTechnology(edge);
  if (technology) args.push(quote(technology));
  return `${edge.directed ? 'Rel' : 'BiRel'}(${args.join(', ')})`;
}

export function c4PlantUmlSource(document: DraftDocument): string {
  const rooms = collectRooms(document);
  const aliases = aliasTable(rooms);
  const usesComponents = { value: false };
  const body: string[] = [];
  rooms.forEach((room, index) => {
    if (index === 0) {
      body.push(...renderRoom(document, room, aliases, 0, usesComponents));
      return;
    }
    // The inside of a shape, drawn as a boundary carrying that shape's name — the shape itself is
    // already an element in the room above. The alias is derived so no element can take it.
    const owner = room.owners[room.owners.length - 1]!;
    body.push('', `Container_Boundary(${aliases.get(owner.id)!}_inside, ${quote(nameOf(owner))}) {`);
    body.push(...renderRoom(document, room, aliases, 1, usesComponents));
    body.push('}');
  });
  const lines = [
    `' Generated by Draft Canvas from ${quote(titleOf(document))}`,
    '@startuml',
    // `C4_Component` includes the container and context macros; `C4_Container` the context ones.
    `!include <C4/${usesComponents.value ? 'C4_Component' : 'C4_Container'}>`,
    '',
    `title ${escapeText(titleOf(document))}`,
    '',
    ...body,
    '',
    'SHOW_LEGEND()',
    '@enduml',
  ];
  return `${lines.join('\n')}\n`;
}
