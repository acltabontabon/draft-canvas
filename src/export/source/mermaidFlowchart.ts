/**
 * DraftDocument → Mermaid `flowchart LR` text: the architecture itself, not a Flow's telling of it
 * (that is `sequence/mermaid.ts`). Every room is one `subgraph`, boundaries are nested subgraphs,
 * and each shape keeps a silhouette Mermaid can draw: a box for a service or component, a cylinder
 * for a data store, a double-walled box for a queue, a circle for an actor. Checked against the
 * real parser in `tests/source-formats.test.ts`.
 */

import type { DraftDocument, DraftEdge, DraftNode } from '../../document/types';
import {
  aliasTable,
  boundaryTree,
  collectRooms,
  edgeCaption,
  edgesBetween,
  isArchitecture,
  isBoundary,
  oneLine,
  roomTitleFor,
  titleOf,
  type ExportRoom,
} from './shared';

const INDENT = '    ';

/**
 * Words a flowchart reads as statements or shapes when they stand alone as a node id. `aliasFor`
 * already refuses the sequence-diagram set (`end`, `note`, …); these are the flowchart's own.
 */
const FLOWCHART_RESERVED = new Set([
  'graph',
  'flowchart',
  'subgraph',
  'direction',
  'style',
  'class',
  'classdef',
  'click',
  'linkstyle',
  'default',
  'interpolate',
  'call',
  'href',
  'callback',
  'tb',
  'td',
  'bt',
  'rl',
  'lr',
  // A bare `o`/`x` after an arrow is a circle/cross arrowhead, not a node.
  'o',
  'x',
]);

/**
 * Mermaid's entity codes, resolved after parsing so each renders as the literal character. Inside a
 * quoted label the quote itself has to go the same way; `#`, `;` and `%` end statements, start
 * comments or open a `%%{ … }%%` directive wherever they sit, quoted or not — the same reasoning as
 * `sequence/mermaid.ts`'s `escapeMermaidText`. Tags are stripped by Mermaid's HTML sanitizer, so
 * `<` and `>` become entities too.
 */
const ENTITY: Record<string, string> = {
  '"': '#quot;',
  '#': '#35;',
  ';': '#59;',
  '%': '#37;',
  '<': '#lt;',
  '>': '#gt;',
  '&': '#amp;',
  // `|` ends a piped edge label; `(`/`)`/`[`/`]`/`{`/`}` are shape delimiters even inside a quoted
  // label on some Mermaid versions, so every bracket goes through an entity too.
  '|': '#124;',
  '(': '#40;',
  ')': '#41;',
  '[': '#91;',
  ']': '#93;',
  '{': '#123;',
  '}': '#125;',
};

function escapeLabel(text: string): string {
  return oneLine(text).replace(/["#;%<>&|()[\]{}]/g, (ch) => ENTITY[ch]!);
}

function quoted(text: string, fallback: string): string {
  return `"${escapeLabel(text) || fallback}"`;
}

/** The shape brackets Mermaid draws each kind as — `[( )]` is the cylinder, `(( ))` the circle. */
function shapeOf(node: DraftNode, label: string): string {
  switch (node.type) {
    case 'database':
      return `[(${label})]`;
    case 'queue':
      return `[[${label}]]`;
    case 'actor':
      return `((${label}))`;
    case 'ellipse':
      // A junction is a point, drawn as the smallest circle Mermaid has.
      return `(( ))`;
    default:
      return `[${label}]`;
  }
}

/** `-- "text" -->` for a directed call, `-. "text" .->` for an asynchronous one, `---` undirected. */
function arrowOf(edge: DraftEdge, caption: string): string {
  const label = caption ? ` ${quoted(caption, 'link')} ` : '';
  if (!edge.directed) return caption ? `--${label}---` : '---';
  if (edge.async) return caption ? `-.${label}.->` : '-.->';
  return caption ? `--${label}-->` : '-->';
}

function nodeLine(node: DraftNode, alias: string, depth: number): string {
  const label = node.type === 'ellipse' ? '' : quoted(oneLine(node.text) || alias, alias);
  return `${INDENT.repeat(depth)}${alias}${shapeOf(node, label)}`;
}

function renderGraph(room: ExportRoom, aliases: Map<string, string>, depth: number): string[] {
  const graph = room.document;
  const exportable = (node: DraftNode) => isArchitecture(node) || isBoundary(node) || node.type === 'ellipse';
  const tree = boundaryTree(graph.nodes.filter(exportable));
  const lines: string[] = [];
  const emit = (nodes: readonly DraftNode[], level: number) => {
    for (const node of nodes) {
      const alias = aliases.get(node.id)!;
      if (isBoundary(node)) {
        lines.push(`${INDENT.repeat(level)}subgraph ${alias}[${quoted(oneLine(node.text) || 'Boundary', 'Boundary')}]`);
        emit(tree.childrenOf(node), level + 1);
        lines.push(`${INDENT.repeat(level)}end`);
      } else {
        lines.push(nodeLine(node, alias, level));
      }
    }
  };
  emit(tree.roots, depth);

  const exported = new Set(graph.nodes.filter((node) => exportable(node) && !isBoundary(node)).map((node) => node.id));
  const edges = edgesBetween(graph, exported);
  if (edges.length > 0 && lines.length > 0) lines.push('');
  for (const edge of edges) {
    lines.push(`${INDENT.repeat(depth)}${aliases.get(edge.source)!} ${arrowOf(edge, edgeCaption(graph, edge))} ${aliases.get(edge.target)!}`);
  }
  return lines;
}

export function mermaidFlowchartSource(document: DraftDocument): string {
  const rooms = collectRooms(document);
  // Each nested room gets a `RoomN` subgraph of its own below; no shape may take that name first.
  const reserved = new Set([...FLOWCHART_RESERVED, ...rooms.map((_, index) => `room${index}`)]);
  const aliases = aliasTable(rooms, reserved);
  const lines = [`%% Generated by Draft Canvas from ${quoted(titleOf(document), 'Canvas')}`, 'flowchart LR'];
  rooms.forEach((room, index) => {
    if (index === 0) {
      lines.push(...renderGraph(room, aliases, 1));
      return;
    }
    // A room is the inside of a shape declared in the room above it; Mermaid cannot nest a graph in
    // a node, so each one is a top-level subgraph named for the path that reaches it.
    lines.push('', `${INDENT}subgraph Room${index}[${quoted(roomTitleFor(room), 'Room')}]`);
    lines.push(...renderGraph(room, aliases, 2));
    lines.push(`${INDENT}end`);
  });
  return `${lines.join('\n')}\n`;
}
