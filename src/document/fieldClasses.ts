/**
 * What every field of a shape, a connector and an attachment is: where it sits, how it looks, what
 * it says, or what it means. The one table of it. Shared by the agent's review rows
 * (`agent/proposal.ts`), Canvas Evolution's semantic diff and merge, the outage walk's memo and the
 * architecture model (`model/`), so "moved", "restyled", "renamed" and "means something else" are
 * the same answer everywhere.
 *
 * The tables are checked against the types: a field added to `DraftNode`, `DraftEdge` or
 * `Attachment` does not compile until it is given a class here.
 */

import type { Attachment, DraftEdge, DraftNode } from './types';

export type FieldClass =
  /** Where it is and how big: a move, a resize, a reroute. */
  | 'layout'
  /** What it is called or says. */
  | 'text'
  /** How it looks, with no change to what it means. */
  | 'style'
  /** Which boundary it sits in. */
  | 'grouping'
  /** What a connector joins, and what kind of relationship it is. */
  | 'relationship'
  /** A Junction's group, or a connector's travel to another room. */
  | 'navigation'
  /** Everything else that changes what the element means. */
  | 'property';

const NODE_FIELDS = {
  id: 'property',
  type: 'property',
  x: 'layout',
  y: 'layout',
  width: 'layout',
  height: 'layout',
  z: 'layout',
  parentId: 'grouping',
  text: 'text',
  description: 'text',
  technology: 'property',
  kindOrigin: 'property',
  textOrigin: 'property',
  accent: 'style',
  noteKind: 'property',
  language: 'text',
  code: 'text',
  serviceKind: 'property',
  replicas: 'property',
  databaseKind: 'property',
  queueKind: 'property',
  actorKind: 'property',
  actorFrame: 'style',
  componentKind: 'property',
  artifactKind: 'property',
  // Which kind of boundary a group is decides what its contents are: a `system` boundary makes
  // them internal to that system (`depth/c4.ts`). It was filed under style until 2.0.
  boundaryPreset: 'property',
  attachments: 'property',
  evidence: 'property',
  deliveryRole: 'property',
  annotation: 'text',
  textRole: 'style',
  textAlign: 'style',
  textBold: 'style',
  textItalic: 'style',
  textFont: 'style',
  textBackground: 'style',
  inside: 'property',
  sequence: 'property',
  held: 'property',
  link: 'navigation',
} as const satisfies Record<keyof DraftNode, FieldClass>;

const EDGE_FIELDS = {
  id: 'property',
  source: 'relationship',
  target: 'relationship',
  label: 'text',
  directed: 'relationship',
  // A connector's routing style (straight, orthogonal) changes its path, not what it joins.
  routing: 'layout',
  accent: 'style',
  details: 'text',
  semantic: 'relationship',
  compensationFor: 'relationship',
  compensationVisible: 'property',
  compensationName: 'property',
  compensationProtocol: 'property',
  compensationDescription: 'property',
  condition: 'text',
  cadence: 'relationship',
  response: 'text',
  hasResponse: 'relationship',
  kind: 'relationship',
  async: 'relationship',
  // Anchors say where on a shape a connector meets it, never which shape.
  sourceAnchor: 'layout',
  targetAnchor: 'layout',
  routeMode: 'layout',
  waypoints: 'layout',
  portal: 'navigation',
  semanticsOrigin: 'property',
  attachments: 'property',
  evidence: 'property',
  deliveryAttempts: 'relationship',
} as const satisfies Record<keyof DraftEdge, FieldClass>;

const ATTACHMENT_FIELDS = {
  id: 'property',
  type: 'property',
  text: 'text',
  noteKind: 'property',
  language: 'text',
  code: 'text',
  accent: 'style',
  width: 'layout',
  height: 'layout',
} as const satisfies Record<keyof Attachment, FieldClass>;

/** A name means the same on a shape, a connector and an attachment, so one lookup serves all three. */
const FIELDS: Readonly<Record<string, FieldClass>> = { ...ATTACHMENT_FIELDS, ...EDGE_FIELDS, ...NODE_FIELDS };

export function classOfField(field: string): FieldClass {
  return Object.hasOwn(FIELDS, field) ? FIELDS[field]! : 'property';
}

/**
 * Pure geometry: a change to only these is a move, a resize or a reroute. `routing` is layout too,
 * but it is a choice of line style someone made, so a review still lists it.
 */
export const GEOMETRY_FIELDS: ReadonlySet<string> = new Set(['x', 'y', 'width', 'height', 'z', 'sourceAnchor', 'targetAnchor', 'routeMode', 'waypoints']);

/**
 * What a shape says about the architecture: what it is, what it is called, what it is built with
 * and which boundary holds it. Everything an analysis of the diagram may read from a shape, and
 * nothing about where or how it is drawn. `inside` is the room a shape owns, read through
 * `depth/tree.ts`, never compared here.
 */
export const ARCHITECTURE_NODE_FIELDS = [
  'type',
  'text',
  'parentId',
  'technology',
  'serviceKind',
  'databaseKind',
  'queueKind',
  'actorKind',
  'componentKind',
  'artifactKind',
  'boundaryPreset',
  'deliveryRole',
  'replicas',
] as const satisfies readonly (keyof DraftNode)[];

/** What a connector says about the architecture: what it joins and what kind of relationship it is. */
export const ARCHITECTURE_EDGE_FIELDS = [
  'source',
  'target',
  'directed',
  'semantic',
  'kind',
  'async',
  'condition',
  'cadence',
  'hasResponse',
  'deliveryAttempts',
  'compensationFor',
] as const satisfies readonly (keyof DraftEdge)[];

/** Two versions of one shape that say the same about the architecture: only a move or a restyle apart. */
export function sameArchitecture(a: DraftNode, b: DraftNode): boolean {
  if (a === b) return true;
  for (const field of ARCHITECTURE_NODE_FIELDS) if (a[field] !== b[field]) return false;
  return true;
}
