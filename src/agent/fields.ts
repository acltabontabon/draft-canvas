/** Runtime field sets are also the keys of the published patch schema. */
export const ROOM_FIELDS = ['level', 'nodes', 'relationships', 'groups', 'flows', 'notes'] as const;
export const SET_FIELDS = {
  element: ['label', 'type', 'description', 'technology', 'color', 'group', 'evidence', 'place'],
  group: ['label', 'kind', 'group', 'color', 'place'],
  // The three free cards a note can be — a note, a code snippet, a label — and an attachment, which
  // is any of them folded onto a host. `attach` turns one into the other, keeping its id.
  note: ['label', 'text', 'kind', 'about', 'near', 'group', 'color', 'attach', 'place'],
  code: ['code', 'language', 'kind', 'about', 'near', 'group', 'color', 'attach', 'place'],
  label: ['label', 'text', 'kind', 'style', 'about', 'near', 'group', 'color', 'attach', 'place'],
  relationship: ['label', 'semantic', 'kind', 'directed', 'async', 'condition', 'color', 'lineStyle', 'response', 'deliveryAttempts', 'from', 'to', 'evidence', 'route'],
  flow: ['title', 'color', 'steps', 'variantOf'],
  attachment: ['label', 'text', 'kind', 'code', 'language', 'about', 'attach'],
  openPoint: ['kind', 'context', 'resolved', 'resolution', 'about'],
} as const;
/** What each object of a create request (and of an `add` op) may carry. The skill's checker
 *  (`skills/draft-canvas/scripts/check_diagram.py`) restates these; `tests/agent-skill.test.ts` keeps it so. */
export const CREATE_FIELDS = {
  request: ['requestId', 'title', 'project', 'starter', ...ROOM_FIELDS, 'layout', 'open', 'allowDuplicateTitle', 'fallbackType'],
  group: ['id', 'label', 'kind', 'parent'],
  element: ['id', 'type', 'label', 'description', 'technology', 'group', 'color', 'attachments', 'inside', 'evidence', 'place'],
  relationship: ['id', 'from', 'to', 'label', 'semantic', 'kind', 'directed', 'async', 'condition', 'color', 'lineStyle', 'response', 'deliveryAttempts', 'attachments', 'evidence', 'route'],
  flow: ['id', 'title', 'color', 'variantOf', 'steps'],
  note: ['id', 'text', 'kind', 'code', 'language', 'about', 'near', 'attach', 'style'],
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
