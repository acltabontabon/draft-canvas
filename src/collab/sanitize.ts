/**
 * The host's check on every change a collaborator sends.
 *
 * A collaborator's copy of Draft Canvas could be anything — an older build, a modified one, a script
 * speaking the protocol. Nothing it sends reaches the owner's file without passing the same
 * validation a file from disk does: each element is run through `normalizeDocument` on a one-element
 * document, so every field is whitelisted, clamped and cut to the same limits, and anything that
 * comes back with a different id (unsafe, duplicated) is refused outright rather than renamed —
 * a renamed element would be a new element the sender never sees acknowledged.
 *
 * References between elements are shape-checked here and settled by `repairReferences` once the
 * changes are applied, against the file as it is then, not as the sender last saw it.
 */
import { LIMITS } from '../document/limits';
import { cleanText } from '../document/sanitize';
import { CURRENT_VERSION, DRAFT_FORMAT, VIEW_LEVELS, type DraftEdge, type DraftFlow, type DraftSettings, type OpenPoint, type ViewLevel } from '../document/types';
import { normalizeDocument } from '../document/validate';
import { isRecord } from '../lib/isRecord';
import { ROOT_ROOM, type Change, type Collection, type NodeValue } from './changes';

/** More changes than this in one patch is not an edit anybody made by hand or by command. */
export const MAX_CHANGES_PER_PATCH = LIMITS.maxNodes + LIMITS.maxEdges + LIMITS.maxOpenPoints + LIMITS.maxFlows + 64;

export type SanitizeResult = { ok: true; changes: Change[] } | { ok: false; reason: string };

export function sanitizeChanges(raw: unknown): SanitizeResult {
  if (!Array.isArray(raw)) return refuse('changes must be a list');
  if (raw.length > MAX_CHANGES_PER_PATCH) return refuse('too many changes');
  const changes: Change[] = [];
  // A diff names each element's value at most once (a move is listed apart from it); a patch that
  // names one twice is not an edit anybody made, and is how one id could be put in two rooms.
  const named = new Set<string>();
  for (const candidate of raw) {
    const change = sanitizeChange(candidate);
    if (typeof change === 'string') return refuse(change);
    if (change.kind === 'node' || change.kind === 'edge' || change.kind === 'flow' || change.kind === 'point' || change.kind === 'move') {
      const key = change.kind === 'move' ? `move:${change.target}:${change.id}` : `${change.kind}:${change.id}`;
      if (named.has(key)) return refuse('the same element twice');
      named.add(key);
    }
    changes.push(change);
  }
  return { ok: true, changes };
}

function refuse(reason: string): SanitizeResult {
  return { ok: false, reason };
}

/** Ids as `validate.ts` accepts them. Node ids are room path segments too, so no control characters. */
export function safeId(value: unknown, node = false): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > LIMITS.maxIdLength || value.trim() !== value) return null;
  if (node) {
    for (let i = 0; i < value.length; i += 1) {
      const code = value.charCodeAt(i);
      if (code <= 0x1f || code === 0x7f) return null;
    }
  }
  return value;
}

function roomOf(value: unknown): string | null {
  return value === ROOT_ROOM ? ROOT_ROOM : safeId(value, true);
}

function sanitizeChange(candidate: unknown): Change | string {
  if (!isRecord(candidate)) return 'unreadable change';
  switch (candidate.kind) {
    case 'node': {
      const id = safeId(candidate.id, true);
      const room = roomOf(candidate.room);
      if (!id || room === null) return 'unreadable node change';
      if (candidate.value === null) return { kind: 'node', id, room, value: null };
      const value = sanitizeNode(candidate.value, id);
      return value ? { kind: 'node', id, room, value } : `unreadable node ${id}`;
    }
    case 'edge': {
      const id = safeId(candidate.id);
      const room = roomOf(candidate.room);
      if (!id || room === null) return 'unreadable connector change';
      if (candidate.value === null) return { kind: 'edge', id, room, value: null };
      const value = sanitizeEdge(candidate.value, id);
      return value ? { kind: 'edge', id, room, value } : `unreadable connector ${id}`;
    }
    case 'flow': {
      const id = safeId(candidate.id);
      const room = roomOf(candidate.room);
      if (!id || room === null) return 'unreadable flow change';
      if (candidate.value === null) return { kind: 'flow', id, room, value: null };
      const value = sanitizeFlow(candidate.value, id);
      return value ? { kind: 'flow', id, room, value } : `unreadable flow ${id}`;
    }
    case 'point': {
      const id = safeId(candidate.id);
      if (!id) return 'unreadable open point change';
      if (candidate.value === null) return { kind: 'point', id, value: null };
      const value = sanitizePoint(candidate.value, id);
      return value ? { kind: 'point', id, value } : `unreadable open point ${id}`;
    }
    case 'move': {
      const target = candidate.target;
      if (target !== 'node' && target !== 'edge' && target !== 'flow') return 'unreadable move';
      const id = safeId(candidate.id, target === 'node');
      const room = roomOf(candidate.room);
      if (!id || room === null) return 'unreadable move';
      return { kind: 'move', target, id, room };
    }
    case 'title': {
      if (typeof candidate.value !== 'string') return 'unreadable title';
      return { kind: 'title', value: cleanText(candidate.value, LIMITS.maxTitleLength).trim() || 'Untitled canvas' };
    }
    case 'settings': {
      const value = sanitizeSettings(candidate.value);
      return value ? { kind: 'settings', value } : 'unreadable settings';
    }
    case 'level': {
      const room = roomOf(candidate.room);
      if (room === null) return 'unreadable level';
      if (candidate.value === null) return { kind: 'level', room, value: null };
      if (typeof candidate.value !== 'string' || !(VIEW_LEVELS as readonly string[]).includes(candidate.value)) return 'unreadable level';
      return { kind: 'level', room, value: candidate.value as ViewLevel };
    }
    case 'order': {
      const room = roomOf(candidate.room);
      const collection = candidate.collection;
      if (room === null || !isCollection(collection) || !Array.isArray(candidate.ids)) return 'unreadable order';
      if (collection === 'points' && room !== ROOT_ROOM) return 'unreadable order';
      if (candidate.ids.length > ORDER_LIMITS[collection]) return 'order too long';
      const ids: string[] = [];
      for (const raw of candidate.ids) {
        const id = safeId(raw, collection === 'nodes');
        if (!id) return 'unreadable order';
        ids.push(id);
      }
      return { kind: 'order', room, collection, ids };
    }
    default:
      return 'unknown change';
  }
}

const ORDER_LIMITS: Record<Collection, number> = {
  nodes: LIMITS.maxNodes,
  edges: LIMITS.maxEdges,
  flows: LIMITS.maxFlows,
  points: LIMITS.maxOpenPoints,
};

function isCollection(value: unknown): value is Collection {
  return value === 'nodes' || value === 'edges' || value === 'flows' || value === 'points';
}

/* --------------------------------------------- one-element documents -- */

function documentOf(parts: { nodes?: unknown[]; edges?: unknown[]; flows?: unknown[]; openPoints?: unknown[]; settings?: unknown }) {
  return normalizeDocument({
    format: DRAFT_FORMAT,
    version: CURRENT_VERSION,
    metadata: { id: 'collab', title: 'collab', createdAt: 0, updatedAt: 0 },
    nodes: parts.nodes ?? [],
    edges: parts.edges ?? [],
    flows: parts.flows ?? [],
    openPoints: parts.openPoints ?? [],
    viewport: { x: 0, y: 0, zoom: 1 },
    settings: parts.settings ?? {},
  });
}

/** A stand-in for an element a value refers to, so validation keeps the reference to it. */
function stubNode(id: string) {
  return { id, type: 'service', x: 0, y: 0, width: 100, height: 60, z: 0 };
}

/** Ids for stand-ins that cannot collide with any id the value itself names. */
function freshIds(taken: ReadonlySet<string>, count: number): string[] {
  const out: string[] = [];
  for (let n = 0; out.length < count; n += 1) {
    const id = `collab-stub-${n}`;
    if (!taken.has(id)) out.push(id);
  }
  return out;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function sanitizeNode(raw: unknown, id: string): NodeValue | null {
  if (!isRecord(raw) || raw.id !== id) return null;
  // Rooms travel as changes to their own elements, never inside a node's value.
  const { inside: _inside, parentId, ...rest } = raw;
  const result = documentOf({ nodes: [rest] });
  if (!result.ok || result.document.nodes.length !== 1) return null;
  const node = result.document.nodes[0]!;
  if (node.id !== id) return null;
  // Validation only keeps a membership it can see the boundary for; whether that boundary exists is
  // `repairReferences`'s question, asked of the real room.
  const parent = safeId(parentId, true);
  if (parent && parent !== id) node.parentId = parent;
  return node;
}

function sanitizeEdge(raw: unknown, id: string): DraftEdge | null {
  if (!isRecord(raw) || raw.id !== id) return null;
  const source = safeId(raw.source, true);
  const target = safeId(raw.target, true);
  if (!source || !target || source === target) return null;
  const result = documentOf({ nodes: [stubNode(source), stubNode(target)], edges: [raw] });
  if (!result.ok || result.document.edges.length !== 1) return null;
  const edge = result.document.edges[0]!;
  return edge.id === id && edge.source === source && edge.target === target ? edge : null;
}

function sanitizeFlow(raw: unknown, id: string): DraftFlow | null {
  if (!isRecord(raw) || raw.id !== id) return null;
  const steps = Array.isArray(raw.steps) ? raw.steps.slice(0, LIMITS.maxStepsPerFlow) : [];
  const edgeIds = new Set<string>();
  const nodeIds = new Set<string>();
  for (const step of steps) {
    if (!isRecord(step)) continue;
    const primary = safeId(step.edgeId);
    if (primary) edgeIds.add(primary);
    for (const ref of strings(step.extraEdgeIds).slice(0, LIMITS.maxExtraMembersPerStep)) if (safeId(ref)) edgeIds.add(ref);
    for (const ref of strings(step.extraNodeIds).slice(0, LIMITS.maxExtraMembersPerStep)) if (safeId(ref, true)) nodeIds.add(ref);
  }
  // Reuse spotlighted shapes for the stand-in connectors. Two extra stubs would push a valid flow
  // covering every allowed shape past maxNodes, silently trimming its last two references.
  const ids = [...nodeIds];
  ids.push(...freshIds(nodeIds, Math.max(0, 2 - ids.length)));
  const [from, to] = ids as [string, string, ...string[]];
  const nodes = ids.map(stubNode);
  const edges = [...edgeIds].map((edgeId) => ({ id: edgeId, source: from, target: to }));
  const { variantOf, ...rest } = raw;
  const result = documentOf({ nodes, edges, flows: [{ ...rest, steps }] });
  if (!result.ok || result.document.flows.length !== 1) return null;
  const flow = result.document.flows[0]!;
  if (flow.id !== id) return null;
  const variant = safeId(variantOf);
  if (variant && variant !== id) flow.variantOf = variant;
  return flow;
}

function sanitizePoint(raw: unknown, id: string): OpenPoint | null {
  if (!isRecord(raw) || raw.id !== id || !Array.isArray(raw.targets)) return null;
  const targets = raw.targets.slice(0, LIMITS.maxOpenPointTargets).filter(isRecord);
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  for (const target of targets) {
    if (target.kind === 'node' && safeId(target.id, true)) nodeIds.add(target.id as string);
    else if (target.kind === 'edge' && safeId(target.id)) edgeIds.add(target.id as string);
  }
  const [from, to] = freshIds(nodeIds, 2) as [string, string];
  const result = documentOf({
    nodes: [stubNode(from), stubNode(to), ...[...nodeIds].map(stubNode)],
    edges: [...edgeIds].map((edgeId) => ({ id: edgeId, source: from, target: to })),
    openPoints: [{ ...raw, targets }],
  });
  if (!result.ok || result.document.openPoints.length !== 1) return null;
  const point = result.document.openPoints[0]!;
  return point.id === id ? point : null;
}

function sanitizeSettings(raw: unknown): DraftSettings | null {
  if (!isRecord(raw)) return null;
  const result = documentOf({ settings: raw });
  if (!result.ok) return null;
  const settings = result.document.settings;
  // An embedded image is a file-in-transit field; a shared edit never carries one.
  if (settings.background.image !== undefined) {
    const { image: _image, ...background } = settings.background;
    return { ...settings, background };
  }
  return settings;
}
