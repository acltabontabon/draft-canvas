/** Runtime field sets are also the keys of the published patch schema. */
export const ROOM_FIELDS = ['level', 'nodes', 'relationships', 'groups', 'flows', 'notes'] as const;
export const SET_FIELDS = {
  element: ['label', 'type', 'description', 'technology', 'color', 'group', 'evidence', 'place'],
  group: ['label', 'kind', 'group', 'color', 'place'],
  // The three free cards a note can be — a note, a code snippet, a label — and an attachment, which
  // is any of them folded onto a host. `attach` turns one into the other, keeping its id.
  note: ['label', 'text', 'kind', 'about', 'near', 'group', 'color', 'attach', 'place'],
  code: ['code', 'language', 'kind', 'about', 'near', 'group', 'color', 'attach', 'place'],
  label: ['label', 'text', 'kind', 'about', 'near', 'group', 'color', 'attach', 'place'],
  relationship: ['label', 'semantic', 'kind', 'directed', 'async', 'condition', 'color', 'lineStyle', 'response', 'deliveryAttempts', 'from', 'to', 'evidence', 'route'],
  flow: ['title', 'color', 'steps', 'variantOf'],
  attachment: ['label', 'text', 'kind', 'code', 'language', 'about', 'attach'],
  openPoint: ['kind', 'context', 'resolved', 'resolution', 'about'],
} as const;
export const OP_FIELDS: Record<string, readonly string[]> = {
  add: ['op', ...ROOM_FIELDS, 'openPoints'],
  update: ['op', 'id', 'set'],
  remove: ['op', 'ids', 'cascade'],
  setLevel: ['op', 'level'],
  arrange: ['op', 'scope', 'connectors', 'move', 'direction', 'spacing', 'primaryFlow'],
  moveInside: ['op', 'owner', 'ids'],
  moveOutside: ['op', 'ids'],
};
