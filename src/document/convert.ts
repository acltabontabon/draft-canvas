/**
 * Turning one architecture shape into another in place — "this is a topic, not a service" without
 * redrawing it. The shape keeps its id, so its connectors, flow steps, open points, attachments,
 * evidence and room all stay exactly where they were; only what belongs to the old shape type (its
 * kind, its default size, an automatic name) is swapped for the new type's own.
 */

import { createNode } from './factory';
import { technologyKindPatch } from './technologyKind';
import type { DraftDocument, DraftNode, DraftNodeType } from './types';

/** The shapes that can become one another: the ones that stand for a running part of a system. */
export const CONVERTIBLE_TYPES = ['service', 'database', 'queue', 'actor', 'component'] as const;
export type ConvertibleType = (typeof CONVERTIBLE_TYPES)[number];

export function isConvertibleType(type: DraftNodeType): type is ConvertibleType {
  return (CONVERTIBLE_TYPES as readonly DraftNodeType[]).includes(type);
}

/** Every field that only means something for one shape type. Cleared on a conversion, then set
 *  afresh from the new type's own defaults. */
const TYPE_FIELDS = [
  'serviceKind',
  'databaseKind',
  'queueKind',
  'deliveryRole',
  'actorKind',
  'actorFrame',
  'componentKind',
  'replicas',
  'kindOrigin',
] as const satisfies readonly (keyof DraftNode)[];

/**
 * The node as `type` would have it. A typed name stays; an automatic one becomes the new type's
 * (a placeholder "Service" turned into an Actor reads "User"). The box takes the new type's
 * default size around the same centre — a Queue's tube and a Service's card have nothing in common
 * — and anything the name or details need beyond that is the caller's to grow into.
 */
export function convertedNode(node: DraftNode, type: ConvertibleType): DraftNode {
  const explicit = node.textOrigin !== 'auto';
  const fresh = createNode({ type, x: 0, y: 0, text: explicit ? node.text : undefined });
  const next: DraftNode = { ...node };
  for (const field of TYPE_FIELDS) delete next[field];
  for (const field of TYPE_FIELDS) {
    if (fresh[field] !== undefined) (next as unknown as Record<string, unknown>)[field] = fresh[field];
  }
  next.type = type;
  next.text = fresh.text;
  next.textOrigin = explicit ? node.textOrigin : 'auto';
  if (next.textOrigin === undefined) delete next.textOrigin;
  next.width = fresh.width;
  next.height = fresh.height;
  next.x = Math.round(node.x + node.width / 2 - fresh.width / 2);
  next.y = Math.round(node.y + node.height / 2 - fresh.height / 2);
  // A technology it carries can fix the new shape's kind too: a Service built "with Kafka" turned
  // into a Queue is a topic.
  const kind = technologyKindPatch(next, next.technology);
  return kind ? stripUndefined({ ...next, ...kind }) : next;
}

/** `convertedNode` applied in a document. Unchanged when the node is missing, already `type`, or
 *  not one of the shapes that convert. */
export function convertNodeType(doc: DraftDocument, nodeId: string, type: ConvertibleType): DraftDocument {
  const index = doc.nodes.findIndex((n) => n.id === nodeId);
  const node = doc.nodes[index];
  if (!node || node.type === type || !isConvertibleType(node.type)) return doc;
  const nodes = doc.nodes.slice();
  nodes[index] = convertedNode(node, type);
  return { ...doc, nodes };
}

/** What each shape is called where a person picks one: "Turn into Data Store". */
export const CONVERTIBLE_TYPE_NAMES: Record<ConvertibleType, string> = {
  service: 'Service',
  database: 'Data Store',
  queue: 'Queue',
  actor: 'Actor',
  component: 'Component',
};

function stripUndefined(node: DraftNode): DraftNode {
  for (const key of Object.keys(node) as (keyof DraftNode)[]) if (node[key] === undefined) delete node[key];
  return node;
}
