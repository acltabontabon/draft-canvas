/** Runtime field sets are also the keys of the published patch schema. */
export const ROOM_FIELDS = ['level', 'nodes', 'relationships', 'groups', 'flows', 'notes'] as const;
export const SET_FIELDS = {
  element: ['label', 'type', 'description', 'technology', 'color', 'group', 'evidence'],
  group: ['label', 'kind', 'group', 'color'],
  note: ['label', 'text', 'kind', 'about', 'near', 'group', 'color'],
  relationship: ['label', 'semantic', 'kind', 'directed', 'async', 'condition', 'evidence'],
  flow: ['title', 'color', 'steps', 'variantOf'],
  attachment: ['label', 'text', 'kind', 'code', 'language', 'about'],
  openPoint: ['kind', 'context', 'resolved', 'resolution', 'about'],
} as const;
export const OP_FIELDS: Record<string, readonly string[]> = {
  add: ['op', ...ROOM_FIELDS, 'openPoints'],
  update: ['op', 'id', 'set'],
  remove: ['op', 'ids', 'cascade'],
  setLevel: ['op', 'level'],
  arrange: ['op', 'scope', 'connectors', 'move', 'direction', 'spacing', 'primaryFlow'],
  moveInside: ['op', 'owner', 'ids'],
};
