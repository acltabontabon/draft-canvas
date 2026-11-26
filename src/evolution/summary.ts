/**
 * Deterministic, factual descriptions of a change — revision messages and session summaries —
 * written from a `SemanticDiff` with no model in the loop.
 *
 * They say what the drawing shows changed and nothing more: "Add Payment Service and PostgreSQL",
 * "Connect API Gateway to Order Service", "Move 4 shapes in Checkout". Never why: intent is not in
 * the document, so a description never claims it. When a change is too varied for one clause, the
 * summary falls back to counts and the body lists the elements.
 */
import { ROOT_ROOM } from '../collab/changes';
import { typeLabel, type Category, type ElementChange, type SemanticDiff } from './diff';

export interface Description {
  summary: string;
  body: string[];
  categories: Category[];
}

function list(names: string[]): string {
  const quoted = names.map((name) => name.trim() || 'Untitled');
  if (quoted.length <= 1) return quoted[0] ?? '';
  return `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)}`;
}

function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

const NOUN: Record<ElementChange['kind'], [string, string]> = {
  node: ['shape', 'shapes'],
  edge: ['connection', 'connections'],
  flow: ['flow', 'flows'],
  point: ['open point', 'open points'],
  ink: ['sketch', 'sketches'],
};

/** "in Checkout" when every change is inside one room, else nothing. */
function where(diff: SemanticDiff, changes: ElementChange[]): string {
  const rooms = new Set(changes.map((change) => change.room));
  if (rooms.size !== 1) return '';
  const [room] = rooms;
  return room === ROOT_ROOM || room === undefined ? '' : ` in ${diff.rooms[room] ?? 'a room'}`;
}

function countPhrase(changes: ElementChange[]): string {
  const parts: string[] = [];
  for (const kind of ['node', 'edge', 'flow', 'point', 'ink'] as const) {
    const n = changes.filter((change) => change.kind === kind).length;
    if (n > 0) parts.push(plural(n, NOUN[kind][0], NOUN[kind][1]));
  }
  return list(parts);
}

function addedOrRemovedPhrase(changes: ElementChange[]): string {
  const nodes = changes.filter((change) => change.kind === 'node');
  const others = changes.filter((change) => change.kind !== 'node');
  const nodePart = nodes.length > 0 && nodes.length <= 3 ? list(nodes.map((change) => change.label)) : nodes.length > 0 ? plural(nodes.length, 'shape') : '';
  const otherPart = others.length > 0 ? countPhrase(others) : '';
  return list([nodePart, otherPart].filter(Boolean));
}

function bodyLine(change: ElementChange, diff: SemanticDiff): string {
  const what = change.kind === 'node' ? `${typeLabel(change.type ?? 'shape')} “${change.label}”` : `${NOUN[change.kind][0]} ${change.label}`;
  const room = change.room !== ROOT_ROOM ? ` (in ${diff.rooms[change.room] ?? 'a room'})` : '';
  if (change.change === 'added') return `+ Added ${what}${room}${change.contained ? ` with ${plural(change.contained, 'element')} inside` : ''}`;
  if (change.change === 'removed') return `- Removed ${what}${room}${change.contained ? ` and ${plural(change.contained, 'element')} inside` : ''}`;
  const moved = change.roomMove ? `, moved to ${change.roomMove.to === ROOT_ROOM ? 'the top level' : (diff.rooms[change.roomMove.to] ?? 'a room')}` : '';
  return `~ Changed ${what}${room}: ${change.categories.join(', ')}${moved}`;
}

/** The one-line summary and the body for a change from one revision to the next. */
export function describe(diff: SemanticDiff): Description {
  const body = diff.elements.slice(0, 24).map((change) => bodyLine(change, diff));
  if (diff.elements.length > 24) body.push(`… and ${plural(diff.elements.length - 24, 'more change')}`);
  for (const change of diff.file) {
    if (change.kind === 'title') body.push('~ Changed the diagram’s title or details');
    if (change.kind === 'style') body.push('~ Changed how the diagram is drawn');
    if (change.kind === 'settings') body.push('~ Changed canvas settings');
  }
  return { summary: summarize(diff), body, categories: diff.categories };
}

function summarize(diff: SemanticDiff): string {
  const els = diff.elements;
  const added = els.filter((change) => change.change === 'added');
  const removed = els.filter((change) => change.change === 'removed');
  const modified = els.filter((change) => change.change === 'modified');

  if (els.length === 0) {
    const kinds = new Set(diff.file.map((change) => change.kind));
    if (kinds.size === 1 && kinds.has('title')) return 'Rename the diagram';
    if (kinds.size === 1 && kinds.has('style')) return 'Change how the diagram is drawn';
    if (kinds.size === 1 && kinds.has('settings')) return 'Change canvas settings';
    if (kinds.size === 1 && kinds.has('order')) return 'Reorder elements';
    if (kinds.size === 1 && kinds.has('level')) return 'Change a view’s level';
    return diff.file.length > 0 ? 'Update the diagram’s settings' : 'Record the diagram';
  }

  // One connector added or removed between two named shapes reads best as a sentence.
  if (els.length === 1 && els[0]!.kind === 'edge' && els[0]!.change !== 'modified') {
    const [from, to] = els[0]!.label.split(' → ');
    return els[0]!.change === 'added' ? `Connect ${from} to ${to}` : `Disconnect ${from} from ${to}`;
  }

  if (removed.length === 0 && modified.length === 0) return `Add ${addedOrRemovedPhrase(added)}${where(diff, added)}`;
  if (added.length === 0 && modified.length === 0) return `Remove ${addedOrRemovedPhrase(removed)}${where(diff, removed)}`;

  if (added.length === 0 && removed.length === 0) {
    const categories = new Set(modified.flatMap((change) => change.categories));
    const scope = where(diff, modified);
    const single = modified.length === 1 ? modified[0]!.label : undefined;
    const many = countPhrase(modified);
    const only = (category: Category) => categories.size === 1 && categories.has(category);
    if (only('layout')) return single ? `Move ${single}${scope}` : `Refine the layout of ${many}${scope}`;
    if (only('style')) return single ? `Restyle ${single}${scope}` : `Restyle ${many}${scope}`;
    if (only('text')) return single ? `Edit the text of ${single}${scope}` : `Edit the text of ${many}${scope}`;
    if (only('grouping')) {
      const into = modified.every((change) => change.roomMove) ? modified[0]!.roomMove!.to : undefined;
      if (single && into !== undefined) return `Move ${single} ${into === ROOT_ROOM ? 'to the top level' : `into ${diff.rooms[into] ?? 'a room'}`}`;
      return single ? `Regroup ${single}${scope}` : `Regroup ${many}${scope}`;
    }
    if (only('relationships')) return single ? `Update the relationship ${single}` : `Update ${plural(modified.length, 'relationship')}${scope}`;
    if (only('navigation')) return single ? `Update how ${single} links to other views` : `Update links between views`;
    if (only('flows')) return single ? `Update the flow ${single}` : `Update ${plural(modified.length, 'flow')}`;
    if (only('annotations')) return `Update notes${scope}`;
    return single ? `Update ${single}${scope}` : `Update ${many}${scope}`;
  }

  // A mix: lead with what was added, then removed, then a count of the rest.
  const parts: string[] = [];
  if (added.length > 0) parts.push(`add ${addedOrRemovedPhrase(added)}`);
  if (removed.length > 0) parts.push(`remove ${addedOrRemovedPhrase(removed)}`);
  if (modified.length > 0) parts.push(`update ${countPhrase(modified)}`);
  const sentence = list(parts);
  const scope = where(diff, els);
  const text = `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}${scope}`;
  return text.length <= 100 ? text : `Edit ${countPhrase(els)}${scope}`;
}

/** Names of the shapes a set of changes touches, for search: "which revisions changed Payments?" */
export function touchedNames(diff: SemanticDiff): string[] {
  return [...new Set(diff.elements.filter((change) => change.kind === 'node').map((change) => change.label))].sort();
}

