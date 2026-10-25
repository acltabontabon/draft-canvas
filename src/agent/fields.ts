import { distance } from './vocabulary';

/**
 * Names agents reach for that this API spells differently, by the field they mean. Recorded from
 * real runs: open points and notes sent with `target`/`elementId` and `text`, which a bare "unknown
 * field" left the agent to guess at for several retries. Only suggested where the field exists.
 */
const MEANT: Record<string, readonly string[]> = {
  about: ['target', 'targets', 'element', 'elements', 'elementid', 'elementids', 'node', 'nodeid', 'nodes', 'ids', 'on', 'for', 'attachto', 'subject', 'ref', 'refs'],
  context: ['text', 'note', 'body', 'description', 'detail', 'details', 'message', 'question', 'content'],
  text: ['content', 'body', 'message', 'note', 'description'],
  label: ['name', 'title', 'caption'],
  title: ['name', 'label'],
  caption: ['text', 'description', 'note', 'label'],
  spotlight: ['highlight', 'lights', 'elements'],
  highlight: ['spotlight', 'lights'],
  relationship: ['edge', 'connector', 'relation', 'rel'],
  from: ['source'],
  to: ['target'],
};

/**
 * What to say about a field `allowed` doesn't have: the field it most likely means (a near spelling,
 * or a name from `MEANT`), and the fields this object takes when there are few enough to list.
 */
export function unknownFieldHint(key: string, allowed: readonly string[]): string {
  const lower = key.toLowerCase();
  // Edit distance cannot be less than the length difference. Skip impossible matches before
  // traversing a hostile field name: validation runs on the page, before the worker's time limit.
  const near = lower.length >= 4 ? allowed.find((field) => field !== key && Math.abs(lower.length - field.length) <= 2 && distance(lower, field.toLowerCase()) <= 2) : undefined;
  const meant = near ?? allowed.find((field) => MEANT[field]?.includes(lower));
  const listed = allowed.length <= 12 ? ` (takes ${allowed.join(', ')})` : '';
  return meant ? `; use ${meant}${listed}` : listed;
}

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
  relationship: ['label', 'semantic', 'kind', 'directed', 'async', 'condition', 'color', 'lineStyle', 'response', 'deliveryAttempts', 'from', 'to', 'compensationFor', 'compensationVisible', 'compensationName', 'compensationProtocol', 'compensationDescription', 'evidence', 'route'],
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
  relationship: ['id', 'from', 'to', 'label', 'semantic', 'kind', 'directed', 'async', 'condition', 'color', 'lineStyle', 'response', 'deliveryAttempts', 'compensationFor', 'compensationVisible', 'compensationName', 'compensationProtocol', 'compensationDescription', 'attachments', 'evidence', 'route'],
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
