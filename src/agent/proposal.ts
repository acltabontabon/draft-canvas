/**
 * `submit_proposal`'s dry-run half: validates a batch of ops against the *current* document exactly
 * as `update_diagram` would (so a bad proposal is refused at submit time, not discovered at review),
 * and captures a bounded "precondition" snapshot — the before-state of every id the ops touch — which
 * is the review UI's conflict-detection mechanism (Phase 4b), distinct from base-revision staleness.
 *
 * Never commits anything: `applyUpdate`'s resulting file is deliberately discarded here.
 */

import type { DepthPath } from '../depth/tree';
import { viewOf } from '../depth/tree';
import type { DraftDocument, DraftEdge, DraftNode } from '../document/types';
import { applyUpdate, type PatchResult } from './patch';

export interface PreconditionSnapshot {
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
  const before = viewOf(file, path);
  const preconditions: PreconditionSnapshot = { nodes: {}, edges: {} };
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
  return { counts: result.counts, advisories: result.advisories, preconditions };
}

/**
 * What changed between a proposal's captured preconditions and the document as it stands now — the
 * blocking conflict check. A successful re-run of the same ops is *not* treated as proof there's no
 * conflict; this comparison is the actual check (see `docs/reference/agent-integration.md`).
 */
export interface PreconditionConflict {
  id: string;
  kind: 'node' | 'edge';
  was: Record<string, unknown>;
  now: Record<string, unknown> | null;
}

export function preconditionConflicts(file: DraftDocument, path: DepthPath, preconditions: PreconditionSnapshot): PreconditionConflict[] {
  const view = viewOf(file, path);
  const conflicts: PreconditionConflict[] = [];
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
  kind: 'element' | 'group' | 'relationship';
  id: string;
  change: 'added' | 'modified' | 'removed';
  label: string;
  fields?: DiffField[];
}

function nodeFields(n: DraftNode): Record<string, string | undefined> {
  return { label: n.text, type: n.type, description: n.description, technology: n.technology, group: n.parentId };
}

function edgeFields(e: DraftEdge): Record<string, string | undefined> {
  return { label: e.label, semantic: e.semantic, kind: e.kind, condition: e.condition };
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

export function diffForReview(before: DraftDocument, after: DraftDocument, path: DepthPath): ElementDiffRow[] {
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

  return rows;
}
