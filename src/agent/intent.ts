import { roomsOf } from '../depth/tree';
import type { DraftDocument } from '../document/types';
import { CONNECTOR_KINDS, EDGE_SEMANTICS } from '../document/types';
import { isArchitecture, isBoundary } from '../document/architectureShapes';
import { AgentError } from './errors';
import { viewPathOf } from './read';
import { ELEMENT_TYPE_NAMES } from './vocabulary';

const label = { type: 'string', minLength: 1, maxLength: 1000 };
const text = (maxLength: number) => ({ type: 'string', maxLength });
const object = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
const shapeSet = { ...object({ label, description: { anyOf: [text(280), { type: 'null' }] }, technology: { anyOf: [text(60), { type: 'null' }] } }, []), minProperties: 1 };
const connectionSet = { ...object({ label: text(1000), from: label, to: label, semantic: { enum: EDGE_SEMANTICS }, kind: { enum: CONNECTOR_KINDS } }, []), minProperties: 1 };

/** Closed intent vocabulary; arbitrary patches still need the ordinary ops contract. */
export const INTENT_SCHEMA = { oneOf: [
  object({ kind: { const: 'shape' }, target: label, set: shapeSet }, ['kind', 'target', 'set']),
  object({ kind: { const: 'add' }, type: { enum: ELEMENT_TYPE_NAMES }, label, description: text(280), technology: text(60) }, ['kind', 'type', 'label']),
  object({ kind: { const: 'connection' }, from: label, to: label, label: text(1000), set: connectionSet }, ['kind', 'from', 'to', 'set']),
  object({ kind: { const: 'connect' }, from: label, to: label, label: text(1000), semantic: { enum: EDGE_SEMANTICS }, kindOfConnection: { enum: CONNECTOR_KINDS } }, ['kind', 'from', 'to']),
] };

export type EditIntent =
  | { kind: 'shape'; target: string; set: { label?: string; description?: string | null; technology?: string | null } }
  | { kind: 'add'; type: string; label: string; description?: string; technology?: string }
  | { kind: 'connection'; from: string; to: string; label?: string; set: { label?: string; from?: string; to?: string; semantic?: string; kind?: string } }
  | { kind: 'connect'; from: string; to: string; label?: string; semantic?: string; kindOfConnection?: string };

function unique<T>(matches: T[], what: string): T {
  if (matches.length !== 1) throw new AgentError(matches.length ? 'INVALID_INPUT' : 'NOT_FOUND', `${matches.length ? 'Ambiguous' : 'Missing'} ${what}. Nothing changed.`, {
    hint: 'Read the target view to disambiguate, then use concrete ops with its revision.', details: { total: matches.length },
  });
  return matches[0]!;
}

/** Resolve against the caller's checked snapshot, then use the SAME ordinary patch/commit pipeline.
 * Never carry selectors into a stored proposal: acceptance must not resolve or retarget them later. */
export function intentPatch(file: DraftDocument, intent: EditIntent, view?: unknown) {
  const path = view === undefined ? undefined : viewPathOf(file, view);
  const rooms = roomsOf(file).filter(room => !path || JSON.stringify(room.path) === JSON.stringify(path));
  const shape = (name: string, within?: readonly string[]) => unique(rooms
    .filter(room => !within || JSON.stringify(room.path) === JSON.stringify(within))
    .flatMap(room => room.graph.nodes.filter(node => (isArchitecture(node) || isBoundary(node)) && node.text === name)
      .map(node => ({ id: node.id, path: [...room.path] }))), 'exact shape label');
  const newId = () => {
    const taken = new Set<string>();
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
          if (key === 'id' && typeof child === 'string') taken.add(child);
          else visit(child);
        }
      }
    };
    visit(file);
    let number = 1;
    while (taken.has(`intent_${number}`)) number += 1;
    return `intent_${number}`;
  };
  const patch = (inside: readonly string[], op: Record<string, unknown>) => ({ view: { inside: [...inside] }, ops: [op] });
  if (intent.kind === 'shape') {
    const target = shape(intent.target);
    return patch(target.path, { op: 'update', id: target.id, set: intent.set });
  }
  if (intent.kind === 'add') {
    const { kind: _kind, ...node } = intent;
    return patch(path ?? [], { op: 'add', nodes: [{ id: newId(), ...node }] });
  }
  if (intent.kind === 'connect') {
    const from = shape(intent.from);
    const to = shape(intent.to, from.path);
    return patch(from.path, { op: 'add', relationships: [{ id: newId(), from: from.id, to: to.id,
      ...(intent.label !== undefined ? { label: intent.label } : {}), ...(intent.semantic ? { semantic: intent.semantic } : {}),
      ...(intent.kindOfConnection ? { kind: intent.kindOfConnection } : {}),
    }] });
  }
  const match = unique(rooms.flatMap(room => {
    const nodes = new Map(room.graph.nodes.map(node => [node.id, node]));
    return room.graph.edges.filter(edge => nodes.get(edge.source)?.text === intent.from && nodes.get(edge.target)?.text === intent.to
      && (intent.label === undefined || (edge.label ?? '') === intent.label)).map(edge => ({ id: edge.id, path: [...room.path] }));
  }), 'exact connection');
  const set = { ...intent.set };
  if (set.from !== undefined) set.from = shape(set.from, match.path).id;
  if (set.to !== undefined) set.to = shape(set.to, match.path).id;
  return patch(match.path, { op: 'update', id: match.id, set });
}
