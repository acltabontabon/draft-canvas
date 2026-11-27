/**
 * What kind of change a change to one field of a shape or connector is. Shared by the agent's
 * review rows (`agent/proposal.ts`) and Canvas Evolution's semantic diff and merge, so "moved",
 * "restyled" and "renamed" mean the same everywhere.
 */

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

/**
 * Pure geometry: a change to only these is a move, a resize or a reroute. Anchors sit here because
 * they say where on a shape a connector meets it, never which shape.
 */
export const GEOMETRY_FIELDS: ReadonlySet<string> = new Set(['x', 'y', 'width', 'height', 'z', 'sourceAnchor', 'targetAnchor', 'routeMode', 'waypoints']);

const TEXT_FIELDS: ReadonlySet<string> = new Set(['text', 'description', 'label', 'condition', 'response', 'code', 'language', 'details', 'annotation']);

const STYLE_FIELDS: ReadonlySet<string> = new Set([
  'accent',
  'textRole',
  'textAlign',
  'textBold',
  'textItalic',
  'textFont',
  'textBackground',
  'actorFrame',
  'boundaryPreset',
]);

const RELATIONSHIP_FIELDS: ReadonlySet<string> = new Set(['source', 'target', 'directed', 'semantic', 'kind', 'async', 'cadence', 'hasResponse', 'deliveryAttempts', 'compensationFor']);

export function classOfField(field: string): FieldClass {
  // A connector's routing style (straight, orthogonal) changes its path, not what it joins.
  if (GEOMETRY_FIELDS.has(field) || field === 'routing') return 'layout';
  if (field === 'parentId') return 'grouping';
  if (field === 'link' || field === 'portal') return 'navigation';
  if (RELATIONSHIP_FIELDS.has(field)) return 'relationship';
  if (TEXT_FIELDS.has(field)) return 'text';
  if (STYLE_FIELDS.has(field)) return 'style';
  return 'property';
}
