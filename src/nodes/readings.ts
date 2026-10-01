import { categoryOf } from '../document/connectorSemantics';
import { effectiveConnectorText } from '../document/edgeSemantics';
import { displayNameFor } from '../document/factory';
import type { DraftEdge, DraftNode, DraftNodeType } from '../document/types';

/**
 * How an element is read aloud — the words a screen reader says for a shape or a connector, and
 * the words the Outline panel lists them by.
 *
 * One module, because the same element is spoken from three places (a node's `aria-label`, the
 * selection announcement, the Outline row) and they must agree: a shape called "Orders API, service"
 * on the canvas and "service: Orders API" in the list would be two things to a listener. A
 * connector's words come from `effectiveConnectorText`, the caption the canvas draws, for the same
 * reason — nothing here invents wording the picture does not show.
 */

const KIND_WORDS: Record<DraftNodeType, string> = {
  text: 'text',
  note: 'note',
  code: 'code',
  service: 'service',
  database: 'data store',
  queue: 'queue',
  actor: 'actor',
  component: 'component',
  group: 'boundary',
  ellipse: 'junction',
};

/** The kind of a shape, in a word or two: "service", "topic", "SQL data store", "system boundary". */
export function kindReading(node: DraftNode): string {
  switch (node.type) {
    case 'queue':
      return node.queueKind ?? 'queue';
    case 'note':
      return node.noteKind && node.noteKind !== 'note' ? `${node.noteKind} note` : 'note';
    case 'group':
      return node.boundaryPreset && node.boundaryPreset !== 'boundary' && node.boundaryPreset !== 'group'
        ? `${node.boundaryPreset} boundary`
        : 'boundary';
    case 'service':
      switch (node.serviceKind) {
        case 'api':
          return 'API service';
        case 'worker':
          return 'worker service';
        case 'external':
          return 'external service';
        case 'gateway':
          return 'gateway';
        case 'scheduler':
          return 'scheduler';
        default:
          return 'service';
      }
    case 'database':
      switch (node.databaseKind) {
        case 'sql':
          return 'SQL data store';
        case 'nosql':
          return 'NoSQL data store';
        case 'cache':
          return 'cache';
        case 'file-system':
          return 'file system';
        case 'object-storage':
          return 'object storage';
        case 'search-index':
          return 'search index';
        case 'table':
          return 'table';
        default:
          return 'data store';
      }
    default:
      return KIND_WORDS[node.type];
  }
}

/** "Orders API, service" — a shape's name and kind, as its `aria-label` says it. */
export function nodeReading(node: DraftNode): string {
  return `${displayNameFor(node)}, ${kindReading(node)}`;
}

type NodeLookup = (id: string) => DraftNode | undefined;

/** The caption a connector shows, with the endpoint categories the canvas resolves it against. */
export function connectorText(edge: DraftEdge, source: DraftNode | undefined, target: DraftNode | undefined): string | undefined {
  return effectiveConnectorText(edge, {
    source: source && categoryOf(source),
    target: target && categoryOf(target),
  });
}

/**
 * "Orders API sends command to Orders" — a connector read as a sentence, in the arrow's direction.
 * A connector with no caption still names both ends ("Orders API to Orders"; "and" for a plain
 * association), so a listener always hears what it joins.
 */
export function connectorReading(edge: DraftEdge, lookup: NodeLookup): string {
  const source = lookup(edge.source);
  const target = lookup(edge.target);
  const from = source ? displayNameFor(source) : 'somewhere';
  const to = target ? displayNameFor(target) : 'somewhere';
  const text = connectorText(edge, source, target);
  if (text) return `${from} ${text} ${to}`;
  return edge.directed ? `${from} to ${to}` : `${from} and ${to}`;
}

/** A lookup over a room's nodes, built once for a batch of readings. */
export function nodeLookupOf(nodes: readonly DraftNode[]): NodeLookup {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return (id) => byId.get(id);
}
