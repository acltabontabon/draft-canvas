/**
 * `update_diagram`: a bounded batch of explicit changes to one view, turned into one recipe over the
 * whole file — committed by the editor as a single undo step, or not at all.
 *
 * The contract, in short:
 * - A field left out keeps its value; `null` clears it (description, technology, colour, group…).
 * - New elements are placed without moving anything already there (`preserve`, the default): laid out
 *   as a block of their own, then set beside the existing element they connect to most. A boundary
 *   that gains an element grows to hold it; if growing would run into a shape that isn't its own, the
 *   request is refused (`LAYOUT_CONSTRAINED`) rather than moving what someone arranged.
 * - `remove` of an element takes its connectors and its place in flows with it (the editor's own
 *   rule); a boundary with contents is refused unless `cascade: true`, which removes them too.
 * - Every id a request names is resolved in the view being edited; existing ids — the editor's own
 *   `n_…` ones included — are addressed as they are.
 */

import { addAction, createAction, removeAction, setActionDone, updateActionText } from '../document/actions';
import {
  addOpenPoint,
  createOpenPoint,
  findOpenPoint,
  removeOpenPoint,
  reopenOpenPoint,
  resolveOpenPoint,
  setOpenPointContext,
  setOpenPointKind,
  setOpenPointResolution,
} from '../document/openPoints';
import { OPEN_POINT_KINDS } from '../document/types';
import { inferRelationship, isEligibleForReinference } from '../document/connectorSemantics';
import { createFlow, setFlowVariantOf } from '../document/flow';
import {
  attachToEdge,
  attachToNode,
  descendantsOf,
  hasAttachmentRoom,
  removeAttachment,
  removeEdgeAttachment,
  removeElements,
  updateAttachment,
  updateEdge,
  updateEdgeAttachment,
  updateNode,
} from '../document/operations';
import { freeOriginFor } from '../document/geometry';
import type { Accent, Attachment, DraftDocument, DraftEdge, DraftFlow, DraftFlowStep, DraftNode } from '../document/types';
import { ACCENTS, CODE_LANGUAGES, CONNECTOR_KINDS, EDGE_SEMANTICS } from '../document/types';
import { embed, viewOf, walkGraphs, type DepthPath } from '../depth/tree';
import { assignAnchors } from '../layout/anchors';
import { anchorOf } from './compile';
import { AgentError, Problems } from './errors';
import { AGENT_LIMITS, readActions, readLayout, readOpenPoints, readRoom, Reader, type LayoutSpec, type RoomSpec } from './input';
import { anchorRectOf, attachNote, captionSizer, connectorFor, edgeLabelSize, lineOf, measureContext, noteNode, placeBlock, placeRoom, sizeToFit } from './place';
import { pastDeadline, repairAnchors } from './route';
import { arrangeView, fitGroups, placeBeside, placeInGroup, readArrange, scopeOf } from './arrange';
import { checkQuality, isBetterReport, isClean, type QualityReport } from './quality';
import { GROUP_KINDS, NOTE_KIND_NAMES, resolveType, suggestTypes } from './vocabulary';

export interface PatchResult {
  file: DraftDocument;
  /** Ids added or changed — what the quality check judges (with what they touch). */
  touched: Set<string>;
  /** `arranged`: shapes and connectors an `arrange` moved or re-anchored. */
  counts: { added: number; updated: number; removed: number; arranged?: number };
  advisories: string[];
  /** Errors and warnings among `touched` and whatever it touches — a partial check, never the whole
   *  file (see `qualityReceipt`'s `'touched'` scope). */
  quality: QualityReport;
}

type Json = Record<string, unknown>;

/** Every id in the file, across every room, of every kind — new ids must avoid all of them. */
export function idsInFile(file: DraftDocument): Set<string> {
  const out = new Set<string>();
  walkGraphs(file, (graph) => {
    for (const n of graph.nodes) {
      out.add(n.id);
      for (const a of n.attachments ?? []) out.add(a.id);
    }
    for (const e of graph.edges) {
      out.add(e.id);
      for (const a of e.attachments ?? []) out.add(a.id);
    }
    for (const f of graph.flows) out.add(f.id);
  });
  for (const a of file.actions) out.add(a.id);
  for (const p of file.openPoints ?? []) out.add(p.id);
  return out;
}

/** A captured selection, frozen by id — `read_selection`'s `scope` passed back on a later edit. An
 *  `add` op is always permitted (including a boundary connection into an outside element); any
 *  `update`/`remove`, or a cascading effect of one, that would touch an id outside this is refused. */
export interface Scope {
  nodes: ReadonlySet<string>;
  edges: ReadonlySet<string>;
}

function readScope(r: Reader, raw: unknown, at: string, view: DraftDocument): Scope | undefined {
  if (raw === undefined || raw === null) return undefined;
  const obj = r.object(raw, at);
  if (!obj) return undefined;
  const nodeIds = r.array(obj.nodes, `${at}/nodes`, 300).filter((id): id is string => typeof id === 'string');
  const edgeIds = r.array(obj.edges, `${at}/edges`, 300).filter((id): id is string => typeof id === 'string');
  const knownNodes = new Set(view.nodes.map((n) => n.id));
  const knownEdges = new Set(view.edges.map((e) => e.id));
  const missing = [...nodeIds.filter((id) => !knownNodes.has(id)), ...edgeIds.filter((id) => !knownEdges.has(id))];
  if (missing.length) {
    r.problems.add('SCOPE_TARGET_MISSING', at, `nothing with id ${missing.map((id) => `"${id}"`).join(', ')} in this view — it may have been removed since the selection was captured`);
  }
  return { nodes: new Set(nodeIds), edges: new Set(edgeIds) };
}

function outOfScope(scope: Scope | undefined, ids: readonly string[], within: 'nodes' | 'edges'): string[] {
  if (!scope) return [];
  const allowed = within === 'nodes' ? scope.nodes : scope.edges;
  return ids.filter((id) => !allowed.has(id));
}

function refuseOutOfScope(r: Reader, at: string, offending: readonly string[]) {
  if (!offending.length) return;
  r.problems.add('OUT_OF_SCOPE', at, `${offending.map((id) => `"${id}"`).join(', ')} ${offending.length === 1 ? 'is' : 'are'} outside the captured selection; expand the scope, or make this change without one`);
}

export function applyUpdate(file: DraftDocument, path: DepthPath, rawOps: unknown, rawLayout: unknown, rawScope: unknown = undefined): PatchResult {
  const problems = new Problems();
  const r = new Reader(problems);
  const ops = r.array(rawOps, '/ops', AGENT_LIMITS.opsPerRequest);
  if (!Array.isArray(rawOps) || ops.length === 0) {
    problems.add('INVALID_INPUT', '/ops', 'is required: a list of changes');
    problems.throwIfAny();
  }
  const layout = readLayout(r, rawLayout, '/layout', new Set());
  problems.throwIfAny();

  const ctx = measureContext();
  const taken = idsInFile(file);
  let view = viewOf(file, path);
  if (!view) throw new AgentError('NOT_FOUND', 'That view no longer exists.');
  const scope = readScope(r, rawScope, '/scope', view);
  problems.throwIfAny();
  let actions = file.actions;
  const touched = new Set<string>();
  const counts: PatchResult['counts'] = { added: 0, updated: 0, removed: 0 };
  const advisories: string[] = [];

  ops.forEach((raw, i) => {
    const at = `/ops/${i}`;
    const op = r.object(raw, at);
    if (!op || !view) return;
    const kind = r.oneOf(op.op, `${at}/op`, ['add', 'update', 'remove', 'setLevel', 'arrange'] as const);
    if (!kind) return;
    if (kind === 'arrange') {
      const request = readArrange(r, op, at, view, layout);
      if (!request || !problems.empty) return;
      if (scope) {
        if (!request.scope) {
          problems.add('OUT_OF_SCOPE', `${at}/scope`, 'a selection scope is active on this request; name what to rearrange with scope: {nodes} or {group} instead of the whole view');
          return;
        }
        refuseOutOfScope(r, `${at}/scope`, outOfScope(scope, [...scopeOf(view, request.scope)], 'nodes'));
        if (!problems.empty) return;
      }
      const arranged = arrangeView(view, request, ctx, problems, at);
      if (!arranged) return;
      view = arranged.view;
      for (const id of arranged.touched) touched.add(id);
      counts.arranged = (counts.arranged ?? 0) + arranged.touched.size;
      return;
    }
    if (kind === 'add') {
      const before = view;
      const existing = {
        elements: new Set(view.nodes.filter((n) => n.type !== 'group' && n.type !== 'note' && n.type !== 'text' && n.type !== 'code').map((n) => n.id)),
        groups: new Set(view.nodes.filter((n) => n.type === 'group').map((n) => n.id)),
        relationships: new Set(view.edges.map((e) => e.id)),
      };
      const room = readRoom(r, op, at, { taken, depth: path.length, existing });
      const anchorable = new Set([...existing.elements, ...existing.relationships, ...room.nodes.map((n) => n.id), ...room.relationships.map((e) => e.id)]);
      const newActions = readActions(r, op.actions, `${at}/actions`, taken, anchorable);
      const newPoints = readOpenPoints(r, op.openPoints, `${at}/openPoints`, taken, anchorable);
      // One flow per title: a second "Main flow" is almost always the first one asked for again.
      room.flows.forEach((flow, j) => {
        const same = view?.flows.find((f) => sameTitle(f.title, flow.title));
        if (same) {
          problems.add('DUPLICATE_FLOW', `${at}/flows/${j}/title`, `a flow "${same.title}" already exists (id "${same.id}"); change it with {op:"update", id:"${same.id}", set:{steps}} instead`);
        }
      });
      if (!problems.empty) return;
      // A newly-added block has nothing manual to preserve, so peer sizing defaults on for it even
      // when the request's own top-level layout (also `arrange`'s base, which defaults it off) left
      // the field unset.
      const blockLayout: LayoutSpec = { ...layout, normalizePeerSizes: layout.normalizePeerSizes ?? true };
      view = addToView(view, room, blockLayout, ctx, touched, advisories);
      for (const a of newActions) {
        const action = createAction(a.text, a.about ? { kind: view.edges.some((e) => e.id === a.about) ? 'edge' : 'node', id: a.about } : undefined);
        if (!action) continue;
        if (a.id) action.id = a.id;
        if (a.done) action.done = true;
        actions = addAction({ ...file, actions }, action).actions;
        counts.added += 1;
      }
      // Root-only like actions, but kept *on the view* (`viewOf` hands every room the file's list, and
      // `embed` carries it home) so `removeElements` below can prune what a later op deletes.
      for (const spec of newPoints) {
        const targets = spec.about.map((id) => ({ kind: view!.edges.some((e) => e.id === id) ? ('edge' as const) : ('node' as const), id }));
        const point = createOpenPoint(spec.kind, targets, spec.context);
        if (!point) continue;
        if (spec.id) point.id = spec.id;
        const next = addOpenPoint(view, point);
        if (next === view) {
          problems.add('LIMIT_EXCEEDED', `${at}/openPoints`, `the diagram holds as many open points as it can (${AGENT_LIMITS.openPointsPerRequest * 4})`);
          continue;
        }
        view = next;
        touched.add(point.id);
        counts.added += 1;
      }
      counts.added += view.nodes.length - before.nodes.length + (view.edges.length - before.edges.length) + (view.flows.length - before.flows.length);
      counts.added += room.notes.filter((n) => n.attachTo).length;
      return;
    }
    if (kind === 'setLevel') {
      const level = op.level === null ? null : r.oneOf(op.level, `${at}/level`, ['context', 'container', 'component'] as const);
      if (level === undefined) return;
      const next: DraftDocument = { ...view };
      if (level === null) delete next.level;
      else next.level = level;
      view = next;
      counts.updated += 1;
      return;
    }
    if (kind === 'remove') {
      const ids = r.array(op.ids, `${at}/ids`, 200).filter((id): id is string => typeof id === 'string');
      const cascade = r.bool(op.cascade, `${at}/cascade`) ?? false;
      const nodeIds: string[] = [];
      const edgeIds: string[] = [];
      for (const id of ids) {
        const node = view.nodes.find((n) => n.id === id);
        if (node) {
          if (outOfScope(scope, [id], 'nodes').length) {
            refuseOutOfScope(r, `${at}/ids`, [id]);
            continue;
          }
          const children = view.nodes.filter((n) => n.parentId === id);
          if (node.type === 'group' && children.length && !cascade) {
            problems.add('INVALID_INPUT', `${at}/ids`, `boundary "${id}" still holds ${children.length} element(s); pass cascade: true to remove them too, or move them out first`);
            continue;
          }
          // A cascade must never reach past the captured scope: check every descendant, not just `id`.
          if (node.type === 'group' && cascade && scope) {
            const offending = outOfScope(scope, descendantsOf(view, id), 'nodes');
            if (offending.length) {
              refuseOutOfScope(r, `${at}/ids`, offending);
              continue;
            }
          }
          nodeIds.push(id);
          continue;
        }
        if (view.edges.some((e) => e.id === id)) {
          if (outOfScope(scope, [id], 'edges').length) {
            refuseOutOfScope(r, `${at}/ids`, [id]);
            continue;
          }
          edgeIds.push(id);
          continue;
        }
        const flow = view.flows.find((f) => f.id === id);
        if (flow) {
          // A scope is always a captured node/edge selection (`read_selection` never returns flow
          // ids), so a flow is never *in* one — a scoped request removing one is always reaching
          // outside it.
          if (scope) {
            refuseOutOfScope(r, `${at}/ids`, [id]);
            continue;
          }
          view = { ...view, flows: view.flows.filter((f) => f.id !== id) };
          counts.removed += 1;
          continue;
        }
        if (path.length === 0 && actions.some((a) => a.id === id)) {
          if (scope) {
            refuseOutOfScope(r, `${at}/ids`, [id]);
            continue;
          }
          actions = removeAction({ ...file, actions }, id).actions;
          counts.removed += 1;
          continue;
        }
        if (findOpenPoint(view, id)) {
          // A point id is never part of a captured node/edge selection, so a scoped request naming one
          // is reaching outside it.
          if (scope) {
            refuseOutOfScope(r, `${at}/ids`, [id]);
            continue;
          }
          view = removeOpenPoint(view, id);
          counts.removed += 1;
          continue;
        }
        const attached = findAttachment(view, id);
        if (attached) {
          if (outOfScope(scope, [attached.hostId], attached.kind === 'node' ? 'nodes' : 'edges').length) {
            refuseOutOfScope(r, `${at}/ids`, [attached.hostId]);
            continue;
          }
          view = attached.kind === 'node' ? removeAttachment(view, attached.hostId, id) : removeEdgeAttachment(view, attached.hostId, id);
          touched.add(attached.hostId);
          counts.removed += 1;
          continue;
        }
        problems.add('INVALID_REFERENCE', `${at}/ids`, `nothing with id "${id}" in this view`);
      }
      if (!problems.empty) return;
      const before = view.nodes.length + view.edges.length;
      view = removeElements(view, nodeIds, edgeIds);
      counts.removed += before - (view.nodes.length + view.edges.length);
      return;
    }
    // update
    const id = typeof op.id === 'string' ? op.id : undefined;
    const set = r.object(op.set, `${at}/set`);
    if (!id || !set) {
      if (!id) problems.add('INVALID_INPUT', `${at}/id`, 'is required');
      return;
    }
    const point = findOpenPoint(view, id);
    if (point) {
      if (scope) {
        refuseOutOfScope(r, `${at}/set`, [id]);
        return;
      }
      view = updateOpenPointOp(r, view, id, set, `${at}/set`);
      if (!problems.empty) return;
      touched.add(id);
      counts.updated += 1;
      return;
    }
    const result = updateOne(r, view, file, actions, id, set, `${at}/set`, ctx, touched, advisories, layout.direction, scope);
    if (!result) return;
    view = result.view;
    actions = result.actions;
    counts.updated += 1;
  });
  problems.throwIfAny();
  if (!view) throw new AgentError('NOT_FOUND', 'That view no longer exists.');

  // Actions are root-only; `embed` carries them home from any room.
  const nextView: DraftDocument = { ...view, actions };
  const nextFile = path.length ? embed(file, path, nextView) : nextView;
  // Only what this request could plausibly have broken — `touched` plus, through `checkQuality`'s
  // pairwise checks, anything untouched it collides with — never a claim the whole file is clean.
  const quality: QualityReport = touched.size ? checkQuality(view.nodes, view.edges, ctx, touched) : { errors: [], warnings: [] };
  return { file: nextFile, touched, counts, advisories, quality };
}

function updateOne(
  r: Reader,
  view: DraftDocument,
  file: DraftDocument,
  actions: DraftDocument['actions'],
  id: string,
  set: Json,
  at: string,
  ctx: ReturnType<typeof measureContext>,
  touched: Set<string>,
  advisories: string[],
  direction: LayoutSpec['direction'],
  scope?: Scope,
): { view: DraftDocument; actions: DraftDocument['actions'] } | undefined {
  const node = view.nodes.find((n) => n.id === id);
  if (node) {
    refuseOutOfScope(r, at, outOfScope(scope, [id], 'nodes'));
    if (!r.problems.empty) return undefined;
    const patch: Partial<DraftNode> = {};
    const clear = (field: string) => set[field] === null;
    if (set.label !== undefined) {
      const label = r.text(set.label, `${at}/label`, node.type === 'note' ? AGENT_LIMITS.noteLength : AGENT_LIMITS.labelLength, { required: true });
      if (label) Object.assign(patch, { text: label, textOrigin: 'explicit' });
    }
    if (set.text !== undefined && node.type === 'note') {
      const text = r.text(set.text, `${at}/text`, AGENT_LIMITS.noteLength, { required: true });
      if (text) patch.text = text;
    }
    if (clear('description')) patch.description = undefined;
    else if (set.description !== undefined) patch.description = r.text(set.description, `${at}/description`, AGENT_LIMITS.descriptionLength);
    if (clear('technology')) patch.technology = undefined;
    else if (set.technology !== undefined) patch.technology = r.text(set.technology, `${at}/technology`, AGENT_LIMITS.technologyLength, { singleLine: true });
    if (clear('color')) patch.accent = undefined;
    else if (set.color !== undefined) {
      const accent = r.oneOf<Accent>(set.color, `${at}/color`, ACCENTS);
      if (accent) patch.accent = accent;
    }
    if (set.type !== undefined) {
      const word = typeof set.type === 'string' ? set.type : '';
      const shape = resolveType(word);
      if (!shape) {
        r.problems.add('UNSUPPORTED_TYPE', `${at}/type`, `unknown type "${word}" — did you mean ${suggestTypes(word).map((s) => `"${s}"`).join(', ')}?`);
      } else if (shape.type !== node.type) {
        r.problems.add('UNSUPPORTED', `${at}/type`, `can't turn a ${node.type} into a ${shape.type}; remove it and add a new element instead`);
      } else {
        Object.assign(patch, shape);
        if (!shape.deliveryRole && node.deliveryRole) patch.deliveryRole = undefined;
      }
    }
    if (set.kind !== undefined && node.type === 'group') {
      const kind = r.oneOf(set.kind, `${at}/kind`, Object.keys(GROUP_KINDS) as (keyof typeof GROUP_KINDS)[]);
      if (kind) patch.boundaryPreset = GROUP_KINDS[kind]?.preset;
    }
    if (set.kind !== undefined && node.type === 'note') {
      const kind = r.oneOf(set.kind, `${at}/kind`, NOTE_KIND_NAMES);
      if (kind) patch.noteKind = kind;
    }
    // A free note moved beside another element (placement only), or into a boundary (membership).
    const beside = node.type === 'note' ? (set.near ?? set.about) : undefined;
    let besideHost: DraftNode | undefined;
    if (beside !== undefined) {
      const target = typeof beside === 'string' ? view.nodes.find((n) => n.id === beside && n.id !== id) : undefined;
      if (target?.type === 'group') set = { ...set, group: target.id };
      else if (target && target.type !== 'note') besideHost = target;
      else r.problems.add('INVALID_REFERENCE', `${at}/${set.near !== undefined ? 'near' : 'about'}`, `no element or group "${String(beside)}" in this view`);
    }
    if (set.group !== undefined) {
      if (set.group === null) patch.parentId = undefined;
      else if (typeof set.group === 'string' && view.nodes.some((n) => n.id === set.group && n.type === 'group') && set.group !== id) {
        // Containment stays a tree: a boundary can't move into its own contents.
        let at2: string | undefined = set.group;
        const seen = new Set<string>();
        while (at2 && !seen.has(at2)) {
          if (at2 === id) {
            r.problems.add('CONTAINMENT_CYCLE', `${at}/group`, `"${id}" would end up inside itself`);
            break;
          }
          seen.add(at2);
          at2 = view.nodes.find((n) => n.id === at2)?.parentId;
        }
        patch.parentId = set.group;
      } else r.problems.add('INVALID_REFERENCE', `${at}/group`, `no group "${String(set.group)}" in this view`);
    }
    if (!r.problems.empty) return undefined;
    let next = updateNode(view, id, patch);
    const updated = next.nodes.find((n) => n.id === id) as DraftNode;
    // Grow (never shrink) to show new text in full — toward whichever side has room.
    if (updated.type !== 'group') {
      const sized = sizeToFit(updated, ctx);
      if (sized.width > updated.width || sized.height > updated.height) {
        next = updateNode(next, id, grownInPlace(next, updated, Math.max(sized.width, updated.width), Math.max(sized.height, updated.height)));
      }
    }
    // A new kind re-derives the connectors inference owns, exactly as a kind change in the inspector does.
    if (set.type !== undefined) {
      const byId = new Map(next.nodes.map((n) => [n.id, n]));
      for (const edge of next.edges) {
        if ((edge.source !== id && edge.target !== id) || !isEligibleForReinference(edge)) continue;
        const rel = inferRelationship(byId.get(edge.source) as DraftNode, byId.get(edge.target) as DraftNode);
        next = updateEdge(next, edge.id, { semantic: rel?.semantic, kind: rel?.kind, semanticsOrigin: rel?.semantic ? 'inferred' : undefined });
      }
    }
    if (besideHost) {
      const moved = placeBeside(next, id, besideHost, direction);
      if (moved) next = moved;
      else r.problems.add('LAYOUT_CONSTRAINED', `${at}/near`, `there is no free space beside "${besideHost.id}" for this note; nothing else is moved to make some`);
    }
    if (node.type === 'note' && typeof set.group === 'string' && set.group !== node.parentId) next = placeInGroup(next, id, set.group);
    else if (patch.parentId !== undefined || set.group !== undefined) next = fitGroups(next, id);
    touched.add(id);
    return { view: next, actions };
  }
  const edge = view.edges.find((e) => e.id === id);
  if (edge) {
    refuseOutOfScope(r, at, outOfScope(scope, [id], 'edges'));
    if (!r.problems.empty) return undefined;
    const patch: Partial<DraftEdge> = {};
    if (set.label === null) patch.label = undefined;
    else if (set.label !== undefined) patch.label = r.text(set.label, `${at}/label`, AGENT_LIMITS.relationshipLabelLength, { singleLine: true });
    if (set.semantic !== undefined) {
      const semantic = r.oneOf(set.semantic, `${at}/semantic`, EDGE_SEMANTICS);
      if (semantic) Object.assign(patch, { semantic, semanticsOrigin: 'explicit' });
    }
    if (set.kind !== undefined) {
      const kind = r.oneOf(set.kind, `${at}/kind`, CONNECTOR_KINDS);
      if (kind) Object.assign(patch, { kind, semanticsOrigin: 'explicit' });
    }
    if (set.directed !== undefined) patch.directed = r.bool(set.directed, `${at}/directed`) ?? edge.directed;
    if (set.async !== undefined) patch.async = r.bool(set.async, `${at}/async`) || undefined;
    if (set.condition === null) patch.condition = undefined;
    else if (set.condition !== undefined) patch.condition = r.text(set.condition, `${at}/condition`, 120, { singleLine: true });
    if (!r.problems.empty) return undefined;
    if (patch.semantic) {
      const byId = new Map(view.nodes.map((n) => [n.id, n]));
      const probe = connectorFor({ id, from: edge.source, to: edge.target, semantic: patch.semantic }, byId.get(edge.source) as DraftNode, byId.get(edge.target) as DraftNode, advisories);
      if (probe.semantic !== patch.semantic) {
        patch.semantic = edge.semantic;
        delete patch.semanticsOrigin;
      }
    }
    touched.add(id);
    return { view: updateEdge(view, id, patch), actions };
  }
  const flowIndex = view.flows.findIndex((f) => f.id === id);
  if (flowIndex >= 0) {
    // Same reasoning as the flow-removal branch above: no scope can ever contain a flow id.
    if (scope) {
      refuseOutOfScope(r, at, [id]);
      return undefined;
    }
    const existing = view.flows[flowIndex] as DraftFlow;
    const flow: DraftFlow = { ...existing };
    if (set.title !== undefined) {
      const title = r.text(set.title, `${at}/title`, AGENT_LIMITS.flowTitleLength, { required: true, singleLine: true });
      const clash = view.flows.find((f) => f.id !== id && title && sameTitle(f.title, title));
      if (clash) r.problems.add('DUPLICATE_FLOW', `${at}/title`, `another flow is already called "${clash.title}" (id "${clash.id}")`);
      if (title) flow.title = title;
    }
    if (set.color === null) delete flow.accent;
    else if (set.color !== undefined) {
      const accent = r.oneOf<Accent>(set.color, `${at}/color`, ACCENTS);
      if (accent) flow.accent = accent;
    }
    // Steps are only rebuilt when given — and even then each keeps its id, its extra highlights and
    // its camera when its relationship is still there, so a small edit never resets a flow's details.
    if (set.steps !== undefined) {
      const steps = flowStepsFor(r, set.steps, `${at}/steps`, existing, new Set(view.edges.map((e) => e.id)));
      if (steps) flow.steps = steps;
    }
    if (set.variantOf === null) delete flow.variantOf;
    else if (set.variantOf !== undefined) {
      const variantOf = typeof set.variantOf === 'string' ? set.variantOf : undefined;
      const target = variantOf && variantOf !== id ? view.flows.find((f) => f.id === variantOf) : undefined;
      if (!target || target.variantOf !== undefined) {
        r.problems.add('INVALID_REFERENCE', `${at}/variantOf`, `must be another flow in this view that is not itself a variant`);
      } else if (view.flows.some((f) => f.variantOf === id)) {
        r.problems.add('INVALID_REFERENCE', `${at}/variantOf`, `a flow with variants of its own cannot become a variant`);
      } else {
        flow.variantOf = variantOf;
      }
    }
    if (!r.problems.empty) return undefined;
    const flows = [...view.flows];
    flows[flowIndex] = flow;
    touched.add(id);
    return { view: { ...view, flows }, actions };
  }
  const attached = findAttachment(view, id);
  if (attached) {
    refuseOutOfScope(r, at, outOfScope(scope, [attached.hostId], attached.kind === 'node' ? 'nodes' : 'edges'));
    if (!r.problems.empty) return undefined;
    return updateAttachmentOp(r, view, attached, set, at, touched, actions);
  }
  const action = actions.find((a) => a.id === id);
  if (action) {
    // Same reasoning again: an action id can never be part of a captured node/edge selection.
    if (scope) {
      refuseOutOfScope(r, at, [id]);
      return undefined;
    }
    let next = { ...file, actions };
    if (set.text !== undefined) {
      const text = r.text(set.text, `${at}/text`, AGENT_LIMITS.actionLength, { required: true, singleLine: true });
      if (text) next = updateActionText(next, id, text);
    }
    if (set.done !== undefined) {
      const done = r.bool(set.done, `${at}/done`);
      if (done !== undefined) next = setActionDone(next, id, done);
    }
    if (set.about !== undefined) {
      const anchor = typeof set.about === 'string' ? anchorOf(file, set.about) : undefined;
      if (set.about !== null && !anchor) r.problems.add('INVALID_REFERENCE', `${at}/about`, `no element or relationship "${String(set.about)}"`);
      next = { ...next, actions: next.actions.map((a) => (a.id === id ? { ...a, ...(anchor ? { anchor } : {}), ...(set.about === null ? { anchor: undefined } : {}) } : a)) };
    }
    return { view, actions: next.actions };
  }
  r.problems.add('INVALID_REFERENCE', at.replace(/\/set$/, '/id'), `nothing with id "${id}" in this view`);
  return undefined;
}

/**
 * Where a shape that needs to be bigger goes: kept by one corner (or its centre) so it grows into
 * free space rather than over a neighbour. The shape being edited changes footprint either way; no
 * *other* shape moves. When every way is blocked it grows from its top-left corner and the quality
 * check refuses the result (`LAYOUT_CONSTRAINED`) — a person's arrangement is theirs to change.
 */
function grownInPlace(view: DraftDocument, node: DraftNode, width: number, height: number): Pick<DraftNode, 'x' | 'y' | 'width' | 'height'> {
  const mine = new Set<string>();
  let at = node.parentId;
  while (at && !mine.has(at)) {
    mine.add(at);
    at = view.nodes.find((n) => n.id === at)?.parentId;
  }
  const others = view.nodes.filter((n) => n.id !== node.id && !mine.has(n.id));
  const MARGIN = 12;
  const clear = (x: number, y: number) =>
    others.every((n) => x + width + MARGIN <= n.x || n.x + n.width + MARGIN <= x || y + height + MARGIN <= n.y || n.y + n.height + MARGIN <= y);
  const dx = node.width - width;
  const dy = node.height - height;
  const candidates = [
    { x: node.x, y: node.y },
    { x: node.x + dx / 2, y: node.y + dy / 2 },
    { x: node.x + dx, y: node.y },
    { x: node.x, y: node.y + dy },
    { x: node.x + dx, y: node.y + dy },
  ].map((c) => ({ x: Math.round(c.x), y: Math.round(c.y) }));
  const chosen = candidates.find((c) => clear(c.x, c.y)) ?? candidates[0]!;
  return { ...chosen, width, height };
}

/**
 * Adds new elements without moving existing ones: the new part is laid out on its own, then placed
 * as one block beside the existing element it connects to most — inside that element's boundary
 * when the new elements belong there, which grows to hold them.
 */
function addToView(
  view: DraftDocument,
  room: RoomSpec,
  layout: LayoutSpec,
  ctx: ReturnType<typeof measureContext>,
  touched: Set<string>,
  advisories: string[],
): DraftDocument {
  const existingIds = new Set(view.nodes.map((n) => n.id));
  const newIds = new Set([...room.nodes.map((n) => n.id), ...room.groups.map((g) => g.id), ...room.notes.map((n) => n.id)]);
  const inner = room.relationships.filter((e) => newIds.has(e.from) && newIds.has(e.to));
  const bridging = room.relationships.filter((e) => !(newIds.has(e.from) && newIds.has(e.to)));
  // New elements that belong to an existing boundary are laid out as its (virtual) contents.
  const intoExisting = room.nodes.filter((n) => n.group && existingIds.has(n.group));
  const hostGroup = intoExisting[0]?.group;
  const spec: RoomSpec = {
    ...room,
    nodes: room.nodes.map((n) => (n.group && existingIds.has(n.group) ? { ...n, group: undefined } : n)) as RoomSpec['nodes'],
    relationships: inner,
    flows: [],
    notes: [],
  };
  const block = spec.nodes.length || spec.groups.length ? placeRoom(spec, layout, ctx) : undefined;
  if (block) advisories.push(...block.advisories);
  // The existing elements the new part connects to, most connections first: where it may go.
  const weight = new Map<string, number>();
  for (const e of bridging) {
    const outside = existingIds.has(e.from) ? e.from : e.to;
    weight.set(outside, (weight.get(outside) ?? 0) + 1);
  }
  const hosts = [...weight.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([id]) => id);

  /** The new part set beside `host` (reading `direction`), and every connector to it anchored. */
  const placeWith = (host: string | undefined, direction: LayoutSpec['direction'], notes: string[]): DraftDocument => {
    const placedNodes: DraftNode[] = [];
    if (block) {
      const hostNode = host ? view.nodes.find((n) => n.id === host) : undefined;
      const minX = Math.min(...block.nodes.map((n) => n.x));
      const minY = Math.min(...block.nodes.map((n) => n.y));
      const size = { width: Math.max(...block.nodes.map((n) => n.x + n.width)) - minX, height: Math.max(...block.nodes.map((n) => n.y + n.height)) - minY };
      // Far enough from the host for the widest caption on a connector into the block to sit clear.
      const lookup = new Map([...view.nodes, ...block.nodes].map((node) => [node.id, node]));
      const captionRoom = Math.max(
        0,
        ...bridging.map((e) => {
          const s = lookup.get(e.from);
          const t = lookup.get(e.to);
          return s && t ? edgeLabelSize(connectorFor(e, s, t, []), s, t, ctx).width : 0;
        }),
      );
      const gap = Math.max(72, captionRoom + 40);
      const feedsHost = bridging.filter((e) => e.to === host).length > bridging.filter((e) => e.from === host).length;
      const touching = bridging.filter((e) => e.from === host || e.to === host).map((e) => block.nodes.find((n) => n.id === (e.from === host ? e.to : e.from)))[0];
      const meets = touching ? lineOf(touching) : undefined;
      const origin =
        (hostNode ? placeBlock(view, hostNode, size, direction, hostGroup, gap, feedsHost, [], meets && { x: meets.x - minX, y: meets.y - minY }) : undefined) ?? freeOriginFor(view, size);
      for (const n of block.nodes) {
        const moved = { ...n, x: Math.round(n.x - minX + origin.x), y: Math.round(n.y - minY + origin.y) };
        if (!moved.parentId && hostGroup && intoExisting.some((s) => s.id === n.id)) moved.parentId = hostGroup;
        placedNodes.push(moved);
      }
    }
    let candidate: DraftDocument = { ...view, nodes: [...view.nodes, ...placedNodes], edges: [...view.edges, ...(block?.edges.map((e) => ({ ...e })) ?? [])] };
    if (hostGroup) candidate = fitGroups(candidate, intoExisting[0]?.id as string);
    // Connectors between new and existing elements, anchored from where both ended up.
    const byId = new Map(candidate.nodes.map((n) => [n.id, n]));
    const cross = bridging.map((e) => connectorFor(e, byId.get(e.from) as DraftNode, byId.get(e.to) as DraftNode, notes));
    const rects = new Map(candidate.nodes.map((n) => [n.id, anchorRectOf(n)]));
    const anchors = assignAnchors(cross, rects, direction);
    for (const e of cross) Object.assign(e, anchors.get(e.id) ?? {});
    repairAnchors(cross, candidate.nodes, captionSizer(candidate.nodes, ctx), [...candidate.edges, ...cross]);
    return { ...candidate, edges: [...candidate.edges, ...cross] };
  };

  // Local repair before any refusal: beside the best-connected element in the reading direction,
  // then across it, then beside the next ones. Only the new part ever moves; the most readable
  // candidate is kept (the first clean one ends the search).
  const other = layout.direction === 'right' ? 'down' : 'right';
  const tries: { host?: string; direction: LayoutSpec['direction'] }[] = hosts.length
    ? [{ host: hosts[0], direction: layout.direction }, ...(block ? [{ host: hosts[0], direction: other as LayoutSpec['direction'] }] : []), ...hosts.slice(1, 3).map((host) => ({ host, direction: layout.direction }))]
    : [{ direction: layout.direction }];
  const judged = new Set([...newIds, ...room.relationships.map((e) => e.id)]);
  let best: { view: DraftDocument; report: QualityReport; notes: string[] } | undefined;
  for (const attempt of tries) {
    if (best && pastDeadline()) break;
    const notes: string[] = [];
    const candidate = placeWith(attempt.host, attempt.direction, notes);
    if (tries.length === 1) {
      best = { view: candidate, report: { errors: [], warnings: [] }, notes };
      break;
    }
    const report = checkQuality(candidate.nodes, candidate.edges, ctx, judged);
    if (!best || isBetterReport(report, best.report)) best = { view: candidate, report, notes };
    if (isClean(report)) break;
  }
  advisories.push(...best!.notes);
  let next = best!.view;

  // Notes: attached to their host, inside their boundary, or beside what they're about — clear of
  // shapes and of connectors as drawn.
  for (const noteSpec of room.notes) {
    const target = noteSpec.attachTo;
    if (target) {
      if (target.kind === 'node') {
        const host = next.nodes.find((n) => n.id === target.id);
        const copy = host && { ...host };
        attachNote(copy, 'node', noteSpec);
        if (copy) next = { ...next, nodes: next.nodes.map((n) => (n.id === copy.id ? copy : n)) };
      } else {
        const host = next.edges.find((e) => e.id === target.id);
        const copy = host && { ...host };
        attachNote(copy, 'edge', noteSpec);
        if (copy) next = { ...next, edges: next.edges.map((e) => (e.id === copy.id ? copy : e)) };
      }
      touched.add(target.id);
      continue;
    }
    const note = noteNode(noteSpec, ctx);
    next = { ...next, nodes: [...next.nodes, note] };
    if (noteSpec.group) {
      next = placeInGroup(next, note.id, noteSpec.group);
      continue;
    }
    const hostNode = noteSpec.near ? next.nodes.find((n) => n.id === noteSpec.near) : undefined;
    const beside = hostNode ? placeBeside(next, note.id, hostNode, layout.direction) : undefined;
    if (beside) next = beside;
    else {
      const at = freeOriginFor({ ...next, nodes: next.nodes.filter((n) => n.id !== note.id) }, note);
      next = updateNode(next, note.id, { x: Math.round(at.x), y: Math.round(at.y) });
    }
  }

  // Flows (they may use new and existing connectors alike). variantOf is linked in a second pass,
  // once every flow in this batch has been added — its target may be another flow added right here.
  for (const f of room.flows) {
    const flow = createFlow({ id: f.id, title: f.title });
    if (f.color) flow.accent = f.color;
    flow.steps = f.steps.map((s, i) => ({ id: `${f.id}.s${i + 1}`, edgeId: s.relationship, ...(s.caption ? { caption: s.caption } : {}) }));
    next = { ...next, flows: [...next.flows, flow] };
  }
  for (const f of room.flows) {
    if (f.variantOf) next = setFlowVariantOf(next, f.id, f.variantOf);
  }
  for (const id of [...newIds, ...room.relationships.map((e) => e.id)]) touched.add(id);
  return next;
}

/**
 * An open point's kind, context, resolution or targets changed — explicitly, field by field. Resolving
 * one is `resolved: true`; it says the discussion moved on, never that a person agreed to anything,
 * and it is as visible in a proposal's review as any other change.
 */
function updateOpenPointOp(r: Reader, view: DraftDocument, id: string, set: Json, at: string): DraftDocument {
  let next = view;
  if (set.kind !== undefined) {
    const kind = r.oneOf(set.kind, `${at}/kind`, OPEN_POINT_KINDS);
    if (kind) next = setOpenPointKind(next, id, kind);
  }
  if (set.context !== undefined) {
    const context = set.context === null ? '' : r.text(set.context, `${at}/context`, AGENT_LIMITS.openPointContextLength);
    if (context !== undefined) next = setOpenPointContext(next, id, context);
  }
  if (set.resolved !== undefined) {
    const resolved = r.bool(set.resolved, `${at}/resolved`);
    if (resolved === true) next = resolveOpenPoint(next, id);
    else if (resolved === false) next = reopenOpenPoint(next, id);
  }
  if (set.resolution !== undefined) {
    const resolution = set.resolution === null ? '' : r.text(set.resolution, `${at}/resolution`, AGENT_LIMITS.openPointContextLength);
    if (resolution !== undefined) next = setOpenPointResolution(next, id, resolution);
  }
  if (set.about !== undefined) {
    const raw = typeof set.about === 'string' ? [set.about] : r.array(set.about, `${at}/about`, AGENT_LIMITS.openPointTargets);
    const about = raw.filter((entry): entry is string => typeof entry === 'string');
    const known = new Set([...view.nodes.map((n) => n.id), ...view.edges.map((e) => e.id)]);
    const missing = about.filter((target) => !known.has(target));
    if (missing.length) r.problems.add('INVALID_REFERENCE', `${at}/about`, `no element or relationship ${missing.map((m) => `"${m}"`).join(', ')} in this view`);
    else if (about.length === 0) r.problems.add('INVALID_INPUT', `${at}/about`, 'a point has to be about at least one element or relationship; remove it instead');
    else {
      const targets = about.map((target) => ({ kind: view.edges.some((e) => e.id === target) ? ('edge' as const) : ('node' as const), id: target }));
      next = { ...next, openPoints: next.openPoints.map((p) => (p.id === id ? { ...p, targets } : p)) };
    }
  }
  return next;
}

/** Two titles name the same thing: case, surrounding and repeated spaces ignored. */
export function sameTitle(a: string, b: string): boolean {
  const key = (s: string) => s.trim().split(/\s+/).join(' ').toLowerCase();
  return key(a) === key(b);
}

interface FoundAttachment {
  kind: 'node' | 'edge';
  hostId: string;
  attachment: Attachment;
}

/** Where an attachment lives in the view: on which element or connector. */
function findAttachment(view: DraftDocument, id: string): FoundAttachment | undefined {
  for (const node of view.nodes) {
    const attachment = node.attachments?.find((a) => a.id === id);
    if (attachment) return { kind: 'node', hostId: node.id, attachment };
  }
  for (const edge of view.edges) {
    const attachment = edge.attachments?.find((a) => a.id === id);
    if (attachment) return { kind: 'edge', hostId: edge.id, attachment };
  }
  return undefined;
}

/**
 * An attachment's text, kind or code changed, or moved to another element or connector (`about`) —
 * with its id, so it is still the same note to the next request.
 */
function updateAttachmentOp(
  r: Reader,
  view: DraftDocument,
  found: FoundAttachment,
  set: Json,
  at: string,
  touched: Set<string>,
  actions: DraftDocument['actions'],
): { view: DraftDocument; actions: DraftDocument['actions'] } | undefined {
  const { attachment, hostId, kind } = found;
  const patch: Partial<Omit<Attachment, 'id'>> = {};
  const isCode = attachment.type === 'code';
  const textField = set.text !== undefined ? 'text' : set.label !== undefined ? 'label' : undefined;
  if (textField && isCode) r.problems.add('UNSUPPORTED', `${at}/${textField}`, 'a code attachment has code, not text');
  else if (textField) {
    const text = r.text(set[textField], `${at}/${textField}`, AGENT_LIMITS.noteLength, { required: true });
    if (text) patch.text = text;
  }
  if (set.kind !== undefined) {
    if (isCode) r.problems.add('UNSUPPORTED', `${at}/kind`, 'a code attachment has no note kind');
    else {
      const noteKind = r.oneOf(set.kind, `${at}/kind`, NOTE_KIND_NAMES);
      if (noteKind) patch.noteKind = noteKind;
    }
  }
  if (set.code !== undefined || set.language !== undefined) {
    if (!isCode) r.problems.add('UNSUPPORTED', `${at}/code`, 'only a code attachment has code');
    else {
      if (set.code !== undefined) {
        const code = r.text(set.code, `${at}/code`, AGENT_LIMITS.codeLength, { required: true });
        if (code !== undefined) patch.code = code;
      }
      if (set.language !== undefined) {
        const language = r.oneOf(set.language, `${at}/language`, CODE_LANGUAGES);
        if (language) patch.language = language;
      }
    }
  }
  let move: { kind: 'node' | 'edge'; id: string } | undefined;
  if (set.about !== undefined && set.about !== hostId) {
    const about = typeof set.about === 'string' ? set.about : undefined;
    const node = about ? view.nodes.find((n) => n.id === about && n.type !== 'group' && n.type !== 'note' && n.type !== 'text' && n.type !== 'code') : undefined;
    const edge = about ? view.edges.find((e) => e.id === about) : undefined;
    if (!node && !edge) r.problems.add('INVALID_REFERENCE', `${at}/about`, `no element or relationship "${String(set.about)}" to attach it to`);
    else if (!hasAttachmentRoom((node ?? edge)!, node ? 'node' : 'edge')) r.problems.add('LIMIT_EXCEEDED', `${at}/about`, `"${about}" can't hold another attachment`);
    else move = { kind: node ? 'node' : 'edge', id: about! };
  }
  if (!r.problems.empty) return undefined;
  let next = kind === 'node' ? updateAttachment(view, hostId, attachment.id, patch) : updateEdgeAttachment(view, hostId, attachment.id, patch);
  if (move) {
    const current = findAttachment(next, attachment.id)!.attachment;
    next = kind === 'node' ? removeAttachment(next, hostId, attachment.id) : removeEdgeAttachment(next, hostId, attachment.id);
    next = move.kind === 'node' ? attachToNode(next, move.id, current) : attachToEdge(next, move.id, current);
    touched.add(move.id);
  }
  touched.add(hostId);
  return { view: next, actions };
}

/**
 * A flow's new step list, read against the steps it has. A step whose relationship was already a
 * step keeps that step — its id, extra highlights and camera — and its caption unless one is given
 * (`caption: null` clears it). `{frame: <step id>}` keeps a frame step (one with no relationship).
 */
function flowStepsFor(r: Reader, raw: unknown, at: string, flow: DraftFlow, relationshipIds: ReadonlySet<string>): DraftFlowStep[] | undefined {
  const items = r.array(raw, at, AGENT_LIMITS.stepsPerFlow);
  if (!Array.isArray(raw)) return undefined;
  const unused = [...flow.steps];
  const usedIds = new Set(flow.steps.map((s) => s.id));
  const seen = new Set<string>();
  const out: DraftFlowStep[] = [];
  let fresh = flow.steps.length;
  const newId = () => {
    let id: string;
    do id = `${flow.id}.s${(fresh += 1)}`;
    while (usedIds.has(id));
    usedIds.add(id);
    return id;
  };
  items.forEach((item, j) => {
    const stepAt = `${at}/${j}`;
    const step = typeof item === 'string' ? { relationship: item } : r.object(item, stepAt);
    if (!step) return;
    if (typeof step.frame === 'string') {
      const frame = unused.find((s) => s.id === step.frame && !s.edgeId);
      if (!frame) r.problems.add('INVALID_REFERENCE', `${stepAt}/frame`, `no frame step "${step.frame}" in this flow`);
      else {
        unused.splice(unused.indexOf(frame), 1);
        out.push(frame);
      }
      return;
    }
    const relationship = typeof step.relationship === 'string' ? step.relationship : undefined;
    if (!relationship || !relationshipIds.has(relationship)) {
      r.problems.add('INVALID_REFERENCE', `${stepAt}/relationship`, relationship ? `no relationship "${relationship}" in this view` : 'is required');
      return;
    }
    if (seen.has(relationship)) {
      r.problems.add('UNSUPPORTED', stepAt, `relationship "${relationship}" is already a step of this flow; a flow visits each relationship once — put a return trip in a second flow`);
      return;
    }
    seen.add(relationship);
    const kept = unused.find((s) => s.edgeId === relationship);
    if (kept) unused.splice(unused.indexOf(kept), 1);
    const base: DraftFlowStep = kept ? { ...kept } : { id: newId(), edgeId: relationship };
    if (step.caption === null) delete base.caption;
    else if (step.caption !== undefined) {
      const caption = r.text(step.caption, `${stepAt}/caption`, AGENT_LIMITS.captionLength, { singleLine: true });
      if (caption) base.caption = caption;
    }
    out.push(base);
  });
  return out;
}
