/**
 * `submit_proposal`'s dry-run half: validates a batch of ops against the *current* document exactly
 * as `update_diagram` would (so a bad proposal is refused at submit time, not discovered at review),
 * and captures a bounded "precondition" snapshot — the before-state of every id the ops touch — which
 * is the review UI's conflict-detection mechanism (Phase 4b), distinct from base-revision staleness.
 *
 * Never commits anything: `applyUpdate`'s resulting file is deliberately discarded here.
 */

import type { DepthPath } from '../depth/tree';
import { viewOf, walkGraphs } from '../depth/tree';
import { AgentError } from './errors';
import type { Attachment, DraftDocument, DraftEdge, DraftFlow, DraftNode, OpenPoint } from '../document/types';
import { OPEN_POINT_LABELS } from '../document/openPoints';
import { applyUpdate, type PatchResult } from './patch';

export interface EntitySnapshot {
  kind: 'node' | 'edge' | 'flow' | 'open point' | 'view';
  path: string[];
  value: Record<string, unknown>;
}

/** Comparable content includes geometry and nested removals, not just labels. */
export function snapshotsOf(file: DraftDocument): Record<string, EntitySnapshot> {
  const out = Object.create(null) as Record<string, EntitySnapshot>;
  walkGraphs(file, (graph, path) => {
    out[`@view:${path.join('/')}`] = { kind: 'view', path: [...path], value: { level: ('level' in graph ? graph.level : undefined) ?? null } };
    for (const node of graph.nodes) {
      const { inside: _inside, ...own } = node;
      out[node.id] = { kind: 'node', path: [...path], value: own };
    }
    for (const edge of graph.edges) out[edge.id] = { kind: 'edge', path: [...path], value: { ...edge } };
    for (const flow of graph.flows) out[flow.id] = { kind: 'flow', path: [...path], value: { ...flow } };
  });
  for (const point of file.openPoints ?? []) out[point.id] = { kind: 'open point', path: [], value: { ...point } };
  return out;
}

function comparable(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
}

export interface PreconditionSnapshot {
  entities?: Record<string, EntitySnapshot>;
  nodes: Record<string, { label: string; type: string; group?: string }>;
  edges: Record<string, { from: string; to: string; label?: string }>;
}

export interface PreparedProposal {
  counts: PatchResult['counts'];
  advisories: string[];
  preconditions: PreconditionSnapshot;
}

export function prepareProposal(file: DraftDocument, path: DepthPath, rawOps: unknown, rawLayout: unknown, rawScope: unknown): PreparedProposal {
  const result = applyUpdate(file, path, rawOps, rawLayout, rawScope);
  if (result.quality.errors.length) throw new AgentError('LAYOUT_CONSTRAINED', 'The proposal would leave unreadable content.', { details: { problems: result.quality.errors } });
  const original = snapshotsOf(file);
  const proposed = snapshotsOf(result.file);
  const entities = Object.create(null) as Record<string, EntitySnapshot>;
  for (const [id, snapshot] of Object.entries(original)) {
    if (comparable(snapshot) !== comparable(proposed[id])) entities[id] = snapshot;
  }
  // Referenced existing elements (an added connector's endpoints, attachment destinations and
  // flow members) are dependencies even when the patch does not change their own fields.
  const dependencies = (value: unknown): void => {
    if (typeof value === 'string' && original[value]) entities[value] = original[value]!;
    else if (Array.isArray(value)) value.forEach(dependencies);
    else if (value && typeof value === 'object') for (const [key, field] of Object.entries(value)) if (['id', 'ids', 'from', 'to', 'group', 'parent', 'about', 'near', 'relationship', 'steps', 'owner', 'nodes', 'relationships', 'flows', 'ops', 'set'].includes(key)) dependencies(field);
  };
  dependencies(rawOps);
  const before = viewOf(file, path);
  const preconditions: PreconditionSnapshot = { nodes: Object.create(null), edges: Object.create(null), entities };
  if (before) {
    const beforeNodes = new Map(before.nodes.map((n) => [n.id, n]));
    const beforeEdges = new Map(before.edges.map((e) => [e.id, e]));
    for (const id of result.touched) {
      const node = beforeNodes.get(id);
      if (node) {
        preconditions.nodes[id] = { label: node.text ?? '', type: node.type, ...(node.parentId ? { group: node.parentId } : {}) };
        continue;
      }
      const edge = beforeEdges.get(id);
      if (edge) preconditions.edges[id] = { from: edge.source, to: edge.target, ...(edge.label ? { label: edge.label } : {}) };
    }
  }
  const diff = diffForReview(file, result.file, path);
  const counts = { added: diff.filter((row) => row.change === 'added').length, updated: diff.filter((row) => row.change === 'modified').length, removed: diff.filter((row) => row.change === 'removed').length, ...(result.counts.arranged ? { arranged: result.counts.arranged } : {}) };
  return { counts, advisories: result.advisories, preconditions };
}

/**
 * What changed between a proposal's captured preconditions and the document as it stands now — the
 * blocking conflict check. A successful re-run of the same ops is *not* treated as proof there's no
 * conflict; this comparison is the actual check (see `docs/reference/agent-integration.md`).
 */
export interface PreconditionConflict {
  id: string;
  kind: EntitySnapshot['kind'];
  was: Record<string, unknown>;
  now: Record<string, unknown> | null;
}

export function preconditionConflicts(file: DraftDocument, path: DepthPath, preconditions: PreconditionSnapshot): PreconditionConflict[] {
  const view = viewOf(file, path);
  const conflicts: PreconditionConflict[] = [];
  if (preconditions.entities) {
    const current = snapshotsOf(file);
    for (const [id, was] of Object.entries(preconditions.entities)) {
      const now = current[id];
      if (comparable(was) !== comparable(now)) conflicts.push({ id, kind: was.kind, was: was.value, now: now?.value ?? null });
    }
    return conflicts;
  }
  // Older persisted proposals keep their original label-only preconditions.
  const nodes = new Map((view?.nodes ?? []).map((n) => [n.id, n]));
  const edges = new Map((view?.edges ?? []).map((e) => [e.id, e]));
  for (const [id, was] of Object.entries(preconditions.nodes)) {
    const now = nodes.get(id);
    const nowValue = now ? { label: now.text ?? '', type: now.type, ...(now.parentId ? { group: now.parentId } : {}) } : null;
    if (!nowValue || nowValue.label !== was.label || nowValue.type !== was.type || nowValue.group !== was.group) {
      conflicts.push({ id, kind: 'node', was, now: nowValue });
    }
  }
  for (const [id, was] of Object.entries(preconditions.edges)) {
    const now = edges.get(id);
    const nowValue = now ? { from: now.source, to: now.target, ...(now.label ? { label: now.label } : {}) } : null;
    if (!nowValue || nowValue.from !== was.from || nowValue.to !== was.to || nowValue.label !== was.label) {
      conflicts.push({ id, kind: 'edge', was, now: nowValue });
    }
  }
  return conflicts;
}

/**
 * A real, field-level change list for the review panel — additions, modifications and removals
 * shown apart (never color alone), and for a modification, the actual before→after values rather
 * than a canvas ghost, since the spec explicitly requires reviewing non-geometric changes (a label,
 * a note's text, a relationship's semantic) that a colored outline can't show.
 */
export interface DiffField {
  field: string;
  before?: string;
  after?: string;
}

export interface ElementDiffRow {
  path?: string[];
  kind: 'element' | 'group' | 'relationship' | 'open point' | 'flow' | 'view' | 'attachment';
  id: string;
  change: 'added' | 'modified' | 'removed';
  label: string;
  fields?: DiffField[];
}

function displayFields(value: Record<string, unknown>): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['id', 'inside', 'attachments', 'textOrigin', 'semanticsOrigin'].includes(key)).map(([key, field]) => [
    key === 'text' ? 'label' : key,
    field === undefined ? undefined : key === 'evidence' && Array.isArray(field) ? field.map((source) => `${source.basis === 'observed' ? 'Observed' : 'Inferred'}: ${source.path}${source.line ? `:${source.line}` : ''}${source.symbol ? ` (${source.symbol})` : ''}${source.commit ? ` @${source.commit}` : ''}${source.explanation ? ` — ${source.explanation}` : ''}`).join('\n') : typeof field === 'string' ? field : JSON.stringify(field),
  ]));
}

function nodeFields(n: DraftNode): Record<string, string | undefined> {
  return displayFields({ ...n });
}

function edgeFields(e: DraftEdge): Record<string, string | undefined> {
  return displayFields({ ...e });
}

function flowFields(flow: DraftFlow, view: DraftDocument | undefined): Record<string, string | undefined> {
  const fields = displayFields({ ...flow });
  fields.steps = flow.steps.map((step, index) => {
    const edge = view?.edges.find((edge) => edge.id === step.edgeId);
    const name = (id: string) => view?.nodes.find((node) => node.id === id)?.text ?? id;
    const interaction = edge ? `${name(edge.source)} → ${name(edge.target)}${edge.label ? `: ${edge.label}` : ''}` : 'Frame';
    const highlights = [...(step.extraNodeIds ?? []).map(name), ...(step.extraEdgeIds ?? [])];
    return `${index + 1}. ${interaction}${step.caption ? ` — ${step.caption}` : ''}${highlights.length ? ` (also highlights ${highlights.join(', ')})` : ''}${step.viewport ? ` (camera ${step.viewport.x}, ${step.viewport.y}, zoom ${step.viewport.zoom})` : ''}`;
  }).join('\n');
  return fields;
}

function attachmentFields(attachment: Attachment): Record<string, string | undefined> {
  return displayFields({ ...attachment });
}

function changedFields(before: Record<string, string | undefined>, after: Record<string, string | undefined>): DiffField[] {
  return Object.keys({ ...before, ...after })
    .filter((field) => before[field] !== after[field])
    .map((field) => ({ field, before: before[field], after: after[field] }));
}

interface DeclaredSpec {
  kind: 'node' | 'group' | 'edge';
  /** The op's own `label`/`from`/`to` — literal strings, never put through the agent's type
   *  vocabulary translation (`src/agent/vocabulary.ts`), unlike an element's `type` (e.g. the agent
   *  word "redis" becomes `DraftNode.type: 'cache'` with a kind of its own) — which is exactly why
   *  `type` is deliberately not part of this check; comparing it would need to re-derive that
   *  translation to mean anything, and getting it wrong would silently defeat the whole check. */
  label?: string;
  source?: string;
  target?: string;
}

function fieldOf(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * What every `add` op in `ops` would create, well enough to check a live id against it — not just
 * that the id matches, but that it's plausibly *this* thing. Flows and notes are deliberately left
 * out: `looksAlreadyApplied` only trusts a match it can verify, and a bare id collision on either of
 * those is treated as unverifiable (Case C), never as confirmation.
 */
function declaredSpecsOf(rawOps: unknown): Map<string, DeclaredSpec> {
  const specs = new Map<string, DeclaredSpec>();
  if (!Array.isArray(rawOps)) return specs;
  for (const raw of rawOps) {
    const op = raw as { op?: unknown; nodes?: unknown; relationships?: unknown; groups?: unknown } | null;
    if (op?.op !== 'add') continue;
    if (Array.isArray(op.nodes)) {
      for (const item of op.nodes) {
        const obj = item as Record<string, unknown> | null;
        const id = obj && fieldOf(obj, 'id');
        if (id) specs.set(id, { kind: 'node', label: fieldOf(obj, 'label') });
      }
    }
    if (Array.isArray(op.groups)) {
      for (const item of op.groups) {
        const obj = item as Record<string, unknown> | null;
        const id = obj && fieldOf(obj, 'id');
        if (id) specs.set(id, { kind: 'group', label: fieldOf(obj, 'label') });
      }
    }
    if (Array.isArray(op.relationships)) {
      for (const item of op.relationships) {
        const obj = item as Record<string, unknown> | null;
        const id = obj && fieldOf(obj, 'id');
        if (id) specs.set(id, { kind: 'edge', source: fieldOf(obj, 'from'), target: fieldOf(obj, 'to'), label: fieldOf(obj, 'label') });
      }
    }
  }
  return specs;
}

/**
 * Case B of the `Accepting`-crash-recovery contract (`docs/reference/agent-integration.md`): a dry
 * run that fails *only* because ids this exact proposal would create already exist is *consistent
 * with* "this already committed, then the app stopped before recording it" — but consistent isn't
 * proof, so this also checks that what's actually at each id in `live` matches what the proposal
 * would have set: an element or group's label (an element's `type` isn't checked — see
 * `DeclaredSpec` — but its label is required by the schema, so this is rarely a weaker check in
 * practice), or a relationship's source, target and label. An id that merely collides — a stuck
 * `Accepting` proposal whose own commit never landed (a revision race in `applyToFile`, say), while
 * something unrelated happened to mint the same agent-chosen id in the meantime — fails that check
 * and correctly falls through to Case C. A group, flow or note id, or a field this function can't
 * verify, is conservatively never confirmed: `false`, not a guess. `conflictingIds` comes from the
 * thrown `AgentError`'s `details.conflictingIds`, which is only ever populated when every problem the
 * dry run found was a `DUPLICATE_ID` (see `Problems.throwIfAny`); a dry run that fails for any other
 * reason, or a *mix* of reasons, is Case C and must never be reported as already applied.
 */
export function looksAlreadyApplied(rawOps: unknown, conflictingIds: readonly string[] | undefined, live: Pick<DraftDocument, 'nodes' | 'edges'> | undefined): boolean {
  if (!conflictingIds || conflictingIds.length === 0 || !live) return false;
  const specs = declaredSpecsOf(rawOps);
  const liveNodes = new Map(live.nodes.map((n) => [n.id, n]));
  const liveEdges = new Map(live.edges.map((e) => [e.id, e]));
  return conflictingIds.every((id) => {
    const spec = specs.get(id);
    if (!spec) return false;
    if (spec.kind === 'edge') {
      const edge = liveEdges.get(id);
      if (!edge) return false;
      if (spec.source !== undefined && edge.source !== spec.source) return false;
      if (spec.target !== undefined && edge.target !== spec.target) return false;
      return spec.label === undefined || edge.label === spec.label;
    }
    const node = liveNodes.get(id);
    if (!node) return false;
    const isGroup = node.type === 'group';
    if (isGroup !== (spec.kind === 'group')) return false;
    return spec.label === undefined || node.text === spec.label;
  });
}

/**
 * The view a change has to be reviewed from: `path`, or the nearest view around it the change also
 * reached — a `moveOutside` sent to an inside view lands its shapes one level up, and a review of the
 * inside view alone would show them only as removed. An outer view counts as reached when anything in
 * it changed besides its owner's inside.
 */
export function reviewPath(before: DraftDocument, after: DraftDocument, path: DepthPath): DepthPath {
  let from = path;
  for (let depth = path.length - 1; depth >= 0; depth -= 1) {
    const outer = path.slice(0, depth);
    const was = viewOf(before, outer);
    const now = viewOf(after, outer);
    if (!was || !now) break;
    const owner = path[depth];
    const same = <T extends { id: string }>(a: readonly T[], b: readonly T[], equal: (x: T, y: T) => boolean) => a.length === b.length && a.every((x, i) => equal(x, b[i]!));
    const outsideOwner = (n: DraftNode) => (n.id === owner ? { ...n, inside: undefined } : n);
    const untouched =
      same(was.nodes, now.nodes, (x, y) => x === y || (x.id === owner && y.id === owner && JSON.stringify(outsideOwner(x)) === JSON.stringify(outsideOwner(y)))) &&
      same(was.edges, now.edges, (x, y) => x === y) &&
      same(was.flows, now.flows, (x, y) => x === y);
    if (!untouched) from = outer;
  }
  return from;
}

export function diffForReview(before: DraftDocument, after: DraftDocument, path: DepthPath, includeRootMetadata = true): ElementDiffRow[] {
  if (includeRootMetadata) {
    const from = reviewPath(before, after, path);
    if (from.length < path.length) return diffAt(before, after, from, true).map((row) => (row.path ? row : { ...row, path: [...from] }));
  }
  return diffAt(before, after, path, includeRootMetadata);
}

function diffAt(before: DraftDocument, after: DraftDocument, path: DepthPath, includeRootMetadata: boolean): ElementDiffRow[] {
  const beforeView = viewOf(before, path);
  const afterView = viewOf(after, path);
  const rows: ElementDiffRow[] = [];

  const beforeNodes = new Map((beforeView?.nodes ?? []).map((n) => [n.id, n]));
  const afterNodes = new Map((afterView?.nodes ?? []).map((n) => [n.id, n]));
  for (const [id, node] of afterNodes) {
    const kind = node.type === 'group' ? 'group' : 'element';
    const was = beforeNodes.get(id);
    if (!was) {
      rows.push({ kind, id, change: 'added', label: node.text ?? '' });
      continue;
    }
    const fields = changedFields(nodeFields(was), nodeFields(node));
    if (fields.length) rows.push({ kind, id, change: 'modified', label: node.text ?? was.text ?? '', fields });
  }
  for (const [id, was] of beforeNodes) {
    if (!afterNodes.has(id)) rows.push({ kind: was.type === 'group' ? 'group' : 'element', id, change: 'removed', label: was.text ?? '' });
  }

  const beforeEdges = new Map((beforeView?.edges ?? []).map((e) => [e.id, e]));
  const afterEdges = new Map((afterView?.edges ?? []).map((e) => [e.id, e]));
  for (const [id, edge] of afterEdges) {
    const was = beforeEdges.get(id);
    if (!was) {
      rows.push({ kind: 'relationship', id, change: 'added', label: edge.label ?? '' });
      continue;
    }
    const fields = changedFields(edgeFields(was), edgeFields(edge));
    if (fields.length) rows.push({ kind: 'relationship', id, change: 'modified', label: edge.label ?? was.label ?? '', fields });
  }
  for (const [id, was] of beforeEdges) {
    if (!afterEdges.has(id)) rows.push({ kind: 'relationship', id, change: 'removed', label: was.label ?? '' });
  }

  const attachmentsIn = (view: DraftDocument | undefined) => new Map((view ? [...view.nodes, ...view.edges] : []).flatMap((host) => (host.attachments ?? []).map((attachment) => [attachment.id, { attachment, hostId: host.id, host: 'source' in host ? host.label ?? host.id : host.text ?? host.id }] as const)));
  const beforeAttachments = attachmentsIn(beforeView);
  const afterAttachments = attachmentsIn(afterView);
  for (const [id, item] of afterAttachments) {
    const was = beforeAttachments.get(id);
    const fields = was ? changedFields(attachmentFields(was.attachment), attachmentFields(item.attachment)) : undefined;
    if (was && was.hostId !== item.hostId) fields?.push({ field: 'about', before: was.host, after: item.host });
    if (!was || fields?.length) rows.push({ kind: 'attachment', id, change: was ? 'modified' : 'added', label: `${item.host} ▸ ${item.attachment.type === 'code' ? 'Code' : 'Note'}`, fields });
  }
  for (const [id, item] of beforeAttachments) if (!afterAttachments.has(id)) rows.push({ kind: 'attachment', id, change: 'removed', label: `${item.host} ▸ ${item.attachment.type === 'code' ? 'Code' : 'Note'}` });

  // Open points are root-only, so they are compared on the file. A point is never an element: one a
  // proposal raises, resolves or rewords shows as its own row — resolving one is a change a reviewer
  // accepts knowingly, never a side effect of accepting the architecture.
  if (includeRootMetadata) {
  const beforePoints = new Map((before.openPoints ?? []).map((p) => [p.id, p]));
  const afterPoints = new Map((after.openPoints ?? []).map((p) => [p.id, p]));
  for (const [id, point] of afterPoints) {
    const was = beforePoints.get(id);
    if (!was) {
      rows.push({ kind: 'open point', id, change: 'added', label: pointLabel(point) });
      continue;
    }
    const fields = changedFields(pointFields(was), pointFields(point));
    if (fields.length) rows.push({ kind: 'open point', id, change: 'modified', label: pointLabel(point), fields });
  }
  for (const [id, was] of beforePoints) {
    if (!afterPoints.has(id)) rows.push({ kind: 'open point', id, change: 'removed', label: pointLabel(was) });
  }

  }

  const beforeFlows = new Map((beforeView?.flows ?? []).map((f) => [f.id, f]));
  const afterFlows = new Map((afterView?.flows ?? []).map((f) => [f.id, f]));
  for (const [id, flow] of afterFlows) {
    const was = beforeFlows.get(id);
    const fields = was ? changedFields(flowFields(was, beforeView), flowFields(flow, afterView)) : undefined;
    if (!was || fields?.length) rows.push({ kind: 'flow', id, change: was ? 'modified' : 'added', label: flow.title, fields });
  }
  for (const [id, flow] of beforeFlows) if (!afterFlows.has(id)) rows.push({ kind: 'flow', id, change: 'removed', label: flow.title });
  if (beforeView?.level !== afterView?.level) rows.push({ kind: 'view', id: '@level', change: 'modified', label: 'C4 level', fields: [{ field: 'level', before: beforeView?.level, after: afterView?.level }] });
  for (const id of new Set([...beforeNodes.keys(), ...afterNodes.keys()])) {
    const node = afterNodes.get(id);
    const was = beforeNodes.get(id);
    if (was?.inside !== node?.inside && (was?.inside || node?.inside)) {
      for (const child of diffAt(before, after, [...path, id], false)) rows.push({ ...child, path: child.path ?? [...path, id], label: `${node?.text ?? was?.text ?? id} ▸ ${child.label}` });
    }
  }
  return rows;
}

/** MCP previews keep a bounded diagnostic diff. The native review keeps the full field values. */
export function diffForPreview(before: DraftDocument, after: DraftDocument, path: DepthPath) {
  const full = diffForReview(before, after, path);
  const diff: Record<string, unknown>[] = [];
  let bytes = 0;
  const shorten = (value: string | undefined) => value === undefined ? undefined : [...value].slice(0, 400).join('');
  for (const row of full) {
    const bounded = { ...row, label: [...row.label].slice(0, 200).join(''), fields: row.fields?.map((field) => ({ ...field, before: shorten(field.before), after: shorten(field.after), ...(field.before && [...field.before].length > 400 ? { beforeTruncated: true } : {}), ...(field.after && [...field.after].length > 400 ? { afterTruncated: true } : {}) })) };
    const size = new TextEncoder().encode(JSON.stringify(bounded)).length;
    if (diff.length >= 100 || bytes + size > 64 * 1024) break;
    bytes += size;
    diff.push(bounded);
  }
  return { diff, ...(diff.length < full.length ? { diffDropped: full.length - diff.length } : {}) };
}

function pointLabel(point: OpenPoint): string {
  return `${OPEN_POINT_LABELS[point.kind]}${point.context ? ` · ${point.context}` : ''}`;
}

function pointFields(point: OpenPoint): Record<string, string | undefined> {
  return {
    kind: point.kind,
    context: point.context,
    resolved: point.resolved ? 'yes' : undefined,
    resolution: point.resolution,
    about: point.targets.map((t) => t.id).join(', '),
  };
}
