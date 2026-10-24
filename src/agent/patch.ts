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
import { inferRelationship, isEligibleForReinference, isSyncPairing, resolveTransparentCategory } from '../document/connectorSemantics';
import { createAttachment } from '../document/factory';
import { deleteFlow, setFlowVariantOf } from '../document/flow';
import {
  attachToEdge,
  attachToNode,
  descendantsOf,
  detachFromEdge,
  detachFromNode,
  hasAttachmentRoom,
  removeAttachment,
  removeEdgeAttachment,
  removeElements,
  updateAttachment,
  updateEdge,
  updateEdgeAttachment,
  updateNode,
} from '../document/operations';
import { reinferIfEligible } from '../document/reinfer';
import { freeOriginFor } from '../document/geometry';
import { DEFAULTS, LIMITS } from '../document/limits';
import type { Accent, AttachableType, Attachment, DraftDocument, DraftEdge, DraftFlow, DraftFlowStep, DraftNode } from '../document/types';
import { ACCENTS, CODE_LANGUAGES, CONNECTOR_KINDS, EDGE_SEMANTICS } from '../document/types';
import { embed, totals, viewOf, walkGraphs, type DepthPath } from '../depth/tree';
import { effectiveLevel } from '../depth/level';
import { assignAnchors } from '../layout/anchors';
import { naturalCodeSize, naturalTextSize } from '../nodes/describe';
import { AgentError, Problems } from './errors';
import {
  AGENT_LIMITS,
  extrasOf,
  readDeliveryAttempts,
  readEvidence,
  readHighlight,
  readLabelStyle,
  readLayout,
  readOpenPoints,
  readResponse,
  readRoom,
  Reader,
  type LayoutSpec,
  type Lightable,
  type RoomSpec,
} from './input';
import { anchorRectOf, attachNote, captionSizer, connectorFor, edgeLabelSize, flowFromSpec, lineOf, measureContext, noteNode, placeBlock, placeRoom, sizeToFit } from './place';
import { pastDeadline, repairAnchors } from './route';
import { arrangeView, fitGroups, placeBeside, placeInGroup, readArrange, scopeOf } from './arrange';
import { arrangeFreshRoom } from './compile';
import { checkQuality, isBetterReport, isClean, type QualityReport } from './quality';
import { moveInside, moveOutside } from './restructure';
import { newFindings, REVIEW_LIMIT, reviewView } from './review';
import { OP_FIELDS, SET_FIELDS } from './fields';
import { GROUP_KINDS, LINE_STYLE_NAMES, LINE_STYLES, NOTE_FORM_NAMES, NOTE_KIND_NAMES, resolveType, suggestTypes } from './vocabulary';
import { applyRoutes, readPlace, readRoute, type PlaceSpec, type RouteSpec } from './placement';
import { applyPlaces } from './placeExplicit';

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

/** The first of the document's file-wide limits `file` is past, if any. */
function overFileLimits(file: DraftDocument): { what: string; count: number; limit: number } | undefined {
  const used = totals(file);
  if (used.nodes > LIMITS.maxNodes) return { what: 'shapes, boundaries and notes', count: used.nodes, limit: LIMITS.maxNodes };
  if (used.edges > LIMITS.maxEdges) return { what: 'relationships', count: used.edges, limit: LIMITS.maxEdges };
  if (used.flows > LIMITS.maxFlows) return { what: 'flows', count: used.flows, limit: LIMITS.maxFlows };
  return undefined;
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
  // The file the view is written back into: the original, until a `moveOutside` changes the view
  // around this one too.
  let base = file;
  let view = viewOf(file, path);
  if (!view) throw new AgentError('NOT_FOUND', 'That view no longer exists.');
  const scope = readScope(r, rawScope, '/scope', view);
  problems.throwIfAny();
  const touched = new Set<string>();
  // What this request placed or routed by hand: its line and caption problems are reported, not
  // refused (`checkQuality`'s `explicit`).
  const explicit = new Set<string>();
  const counts: PatchResult['counts'] = { added: 0, updated: 0, removed: 0 };
  const advisories: string[] = [];

  ops.forEach((raw, i) => {
    const at = `/ops/${i}`;
    const op = r.object(raw, at);
    if (!op || !view) return;
    const kind = r.oneOf(op.op, `${at}/op`, ['add', 'update', 'remove', 'setLevel', 'arrange', 'moveInside', 'moveOutside'] as const);
    if (!kind) { problems.add('INVALID_INPUT', `${at}/op`, 'is required'); return; }
    r.fields(op, at, OP_FIELDS[kind]!);
    if (!problems.empty) return;
    if (kind === 'moveInside') {
      if (scope) { problems.add('OUT_OF_SCOPE', at, 'Restructuring changes two views; make an explicit unscoped request.'); return; }
      const current = path.length ? embed(base, path, view) : view;
      const moved = moveInside(current, path, op.owner, op.ids);
      view = viewOf(moved, path)!;
      for (const id of op.ids as string[]) touched.add(id);
      touched.add(op.owner as string);
      for (const edge of view.edges) touched.add(edge.id);
      counts.updated += (op.ids as string[]).length + 1;
      return;
    }
    if (kind === 'moveOutside') {
      if (scope) { problems.add('OUT_OF_SCOPE', at, 'Restructuring changes two views; make an explicit unscoped request.'); return; }
      const current = path.length ? embed(base, path, view) : view;
      const moved = moveOutside(current, path, op.ids, ctx, layout.direction);
      // The shapes land in the view around this one, so the whole file carries the change.
      base = moved.file;
      view = viewOf(base, path)!;
      advisories.push(...moved.advisories);
      for (const id of moved.touched) touched.add(id);
      counts.updated += (op.ids as string[]).length;
      return;
    }
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
      advisories.push(...(arranged.advisories ?? []));
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
        flows: new Map(view.flows.map((f) => [f.id, f.variantOf])),
      };
      const room = readRoom(r, op, at, { taken, depth: path.length, existing });
      const anchorable = new Set([...existing.elements, ...existing.relationships, ...room.nodes.map((n) => n.id), ...room.relationships.map((e) => e.id)]);
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
      // The per-request caps bound one batch; the document's own limits are file-wide, across every
      // room. Validation would otherwise drop what is over them on the next open, silently — so an
      // add that would pass one is refused here instead.
      const over = overFileLimits(path.length ? embed(base, path, view) : view);
      if (over) {
        problems.add('LIMIT_EXCEEDED', at, `the diagram can hold at most ${over.limit} ${over.what} across all its views; it would have ${over.count}. Remove some first, or start a separate diagram`);
        view = before;
        return;
      }
      // Then what the request placed or routed itself, over where the block was put.
      const places = new Map(room.nodes.flatMap((n) => (n.place ? [[n.id, n.place] as const] : [])));
      const routes = new Map(room.relationships.flatMap((e) => (e.route ? [[e.id, e.route] as const] : [])));
      if (places.size || routes.size) {
        view = touchedBy(view, applyRoutes(applyPlaces(view, places, ctx, at), routes, at), touched);
        for (const id of [...places.keys(), ...routes.keys()]) explicit.add(id);
      }
      // An add may say what level the view is at — the first add into a new inside view usually does.
      if (room.level && room.level !== view.level) {
        view = { ...view, level: room.level };
        counts.updated += 1;
      }
      // Root-only, but kept *on the view* (`viewOf` hands every room the file's list, and `embed`
      // carries it home) so `removeElements` below can prune what a later op deletes.
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
      const ids = r.array(op.ids, `${at}/ids`, 200).filter((id): id is string => {
        if (typeof id !== 'string') { problems.add('INVALID_INPUT', `${at}/ids`, 'ids must be strings'); return false; }
        return true;
      });
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
          // `deleteFlow`, not a filter: a variant of this flow would otherwise keep a `variantOf`
          // pointing at nothing.
          view = deleteFlow(view, id);
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
      const removed = removeElements(view, nodeIds, edgeIds);
      if (scope) {
        // The checks above cover the ids named; `removeElements` also takes every connector touching
        // a removed shape and trims every flow step that lit one — which may lie outside the scope.
        const kept = new Set(removed.edges.map((e) => e.id));
        const cascaded = outOfScope(scope, view.edges.filter((e) => !kept.has(e.id)).map((e) => e.id), 'edges');
        const keptFlows = new Set(removed.flows);
        const editedFlows = view.flows.filter((f) => !keptFlows.has(f)).map((f) => f.id);
        if (cascaded.length || editedFlows.length) {
          refuseOutOfScope(r, `${at}/ids`, cascaded);
          // A flow is never part of a captured selection, so widening the scope can't help.
          if (editedFlows.length) {
            r.problems.add('OUT_OF_SCOPE', `${at}/ids`, `removing these would change ${editedFlows.length === 1 ? 'flow' : 'flows'} ${editedFlows.map((id) => `"${id}"`).join(', ')}, which a captured selection never covers; make this change without a scope`);
          }
          return;
        }
      }
      view = removed;
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
    const targetNode = view.nodes.find((n) => n.id === id);
    const isEdge = view.edges.some((e) => e.id === id);
    const fields = point
      ? SET_FIELDS.openPoint
      : targetNode
        ? SET_FIELDS[NODE_FIELDS[targetNode.type] ?? 'element']
        : isEdge
          ? SET_FIELDS.relationship
          : view.flows.some((f) => f.id === id)
            ? SET_FIELDS.flow
            : SET_FIELDS.attachment;
    r.fields(set, `${at}/set`, fields);
    for (const field of ['kind', 'language', 'lineStyle', 'code', 'attach', 'place']) if (set[field] === null && !(isEdge && field === 'kind')) problems.add('INVALID_INPUT', `${at}/set/${field}`, 'this required field cannot be cleared');
    if (Object.keys(set).length === 0) problems.add('INVALID_INPUT', `${at}/set`, 'name at least one field to change');
    if (!problems.empty) return;
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
    // Where it goes and how it runs are applied after its other fields, which may resize it.
    const { place: rawPlace, route: rawRoute, ...rest } = set;
    const place = rawPlace !== undefined ? readPlace(r, rawPlace, `${at}/set/place`) : undefined;
    const route = rawRoute === undefined || rawRoute === null ? rawRoute : readRoute(r, rawRoute, `${at}/set/route`);
    if (rawPlace !== undefined || rawRoute !== undefined) refuseOutOfScope(r, `${at}/set`, outOfScope(scope, [id], isEdge ? 'edges' : 'nodes'));
    if (!problems.empty) return;
    const before = view;
    if (Object.keys(rest).length) {
      const result = updateOne(r, view, id, rest, `${at}/set`, ctx, touched, advisories, layout.direction, scope);
      if (!result) return;
      view = result.view;
    }
    if (place) {
      view = touchedBy(view, applyPlaces(view, new Map<string, PlaceSpec>([[id, place]]), ctx, `${at}/set/place`), touched);
      explicit.add(id);
    }
    if (route !== undefined) {
      view = touchedBy(view, route === null ? automaticRoute(view, id, layout.direction, ctx) : applyRoutes(view, new Map<string, RouteSpec>([[id, route]])), touched);
      touched.add(id);
      if (route) explicit.add(id);
    }
    if (view !== before) counts.updated += 1;
  });
  problems.throwIfAny();
  if (!view) throw new AgentError('NOT_FOUND', 'That view no longer exists.');

  const nextFile = path.length ? embed(base, path, view) : view;
  // Only what this request could plausibly have broken — `touched` plus, through `checkQuality`'s
  // pairwise checks, anything untouched it collides with — never a claim the whole file is clean.
  const quality: QualityReport = { errors: [], warnings: [] };
  walkGraphs(nextFile, (graph, graphPath) => {
    const original = viewOf(file, graphPath);
    if (original?.nodes === graph.nodes && original?.edges === graph.edges) return;
    const inTouchedRoom = graphPath.some((id) => touched.has(id));
    // `embed` rewrites every owner up the chain, so each ancestor room reads as changed. One holding
    // nothing this request touched has nothing for a focused check to judge — skip its whole pass.
    if (!inTouchedRoom && !graph.nodes.some((n) => touched.has(n.id)) && !graph.edges.some((e) => touched.has(e.id))) return;
    const report = checkQuality(graph.nodes, graph.edges, ctx, inTouchedRoom ? undefined : touched, explicit);
    quality.errors.push(...report.errors);
    quality.warnings.push(...report.warnings);
  });
  // What this change left a pattern missing (`review.ts`): only the findings it brought in, never the
  // view's standing ones — read_diagram's `review` lists those.
  const original = viewOf(file, path);
  if (original && (original.nodes !== view.nodes || original.edges !== view.edges)) {
    const nested = path.length > 0;
    const before = reviewView(original.nodes, original.edges, { level: effectiveLevel(file, path), nested, limit: Infinity });
    const after = reviewView(view.nodes, view.edges, { level: effectiveLevel(nextFile, path), nested, limit: Infinity });
    advisories.push(...newFindings(before, after).slice(0, REVIEW_LIMIT).map((finding) => `Review (${finding.code}): ${finding.message}`));
  }
  return { file: nextFile, touched, counts, advisories, quality };
}

/**
 * What a flow step may light in a view: anything the Flows panel's "+ Selection" can add — its
 * elements, boundaries and cards — and its relationships. Narrower, a step a person lit a note with
 * couldn't be sent back unchanged.
 */
function lightableIn(view: DraftDocument): Lightable {
  return { nodeIds: new Set(view.nodes.map((n) => n.id)), relationshipIds: new Set(view.edges.map((e) => e.id)) };
}

const CARD_NAMES: Record<AttachableType, string> = { note: 'note', code: 'code snippet', text: 'label' };

/** A card's `kind` as reads report it: its note kind, `code` or `label`. */
function formOf(card: { type: string; noteKind?: string }): string {
  return card.type === 'code' ? 'code' : card.type === 'text' ? 'label' : (card.noteKind ?? 'note');
}

/**
 * The host a card may fold onto, by the editor's own rules: any element; a relationship, for a note
 * or a code snippet (not a label); a boundary, for a note or a code snippet (its Add Note / Add
 * Code). Never another card. A host that is full is refused, never trimmed.
 */
function attachmentHost(r: Reader, view: DraftDocument, about: unknown, at: string, type: AttachableType): { kind: 'node' | 'edge'; id: string } | undefined {
  if (typeof about !== 'string') {
    r.problems.add('INVALID_INPUT', at, 'is required with attach: the element, relationship or boundary to attach it to');
    return undefined;
  }
  const node = view.nodes.find((n) => n.id === about);
  const edge = node ? undefined : view.edges.find((e) => e.id === about);
  if ((!node && !edge) || (node && isCard(node))) {
    r.problems.add('INVALID_REFERENCE', at, `no element, relationship or boundary "${about}" to attach it to`);
    return undefined;
  }
  if (type === 'text' && (edge || node?.type === 'group')) {
    r.problems.add('UNSUPPORTED', at, `a label attaches to an element only; "${about}" is a ${edge ? 'relationship' : 'boundary'}`);
    return undefined;
  }
  const kind = node ? 'node' : 'edge';
  if (!hasAttachmentRoom((node ?? edge)!, kind)) {
    r.problems.add('LIMIT_EXCEEDED', at, `"${about}" can't hold another attachment`);
    return undefined;
  }
  return { kind, id: about };
}

/**
 * A relationship's new ends (`from`, `to`), checked by the rules a new one is: elements of this view,
 * never itself, one per direction between two elements plus a compensation twin. `undefined` when
 * neither end changes.
 */
function readEnds(r: Reader, view: DraftDocument, edge: DraftEdge, set: Json, at: string, semantic: DraftEdge['semantic']): { source: string; target: string } | undefined {
  if (set.from === undefined && set.to === undefined) return undefined;
  const end = (field: 'from' | 'to', current: string): string | undefined => {
    const value = set[field];
    if (value === undefined) return current;
    const node = typeof value === 'string' ? view.nodes.find((n) => n.id === value) : undefined;
    if (!node || node.type === 'group' || isCard(node)) {
      r.problems.add('INVALID_REFERENCE', `${at}/${field}`, `no element "${String(value)}" in this view`);
      return undefined;
    }
    return node.id;
  };
  const source = end('from', edge.source);
  const target = end('to', edge.target);
  if (!source || !target) return undefined;
  if (source === edge.source && target === edge.target) return undefined;
  if (source === target) {
    r.problems.add('UNSUPPORTED', at, 'a relationship from an element to itself is not supported');
    return undefined;
  }
  const same = view.edges.filter((e) => e.id !== edge.id && e.source === source && e.target === target);
  if (same.length >= 2 || (same.length === 1 && semantic !== 'compensates' && same[0]?.semantic !== 'compensates')) {
    r.problems.add('UNSUPPORTED', at, `"${same[0]!.id}" already runs from "${source}" to "${target}"; only a compensation (semantic "compensates") may share its direction`);
    return undefined;
  }
  return { source, target };
}

/**
 * A relationship re-pointed in place — the editor's reconnect, or its reverse when the ends swap: the
 * id, label, flows and attachments stay; an inferred meaning is inferred again for what it now
 * connects (`reinferIfEligible`); a moved end is anchored afresh, an unmoved one keeps its anchor.
 */
function repoint(view: DraftDocument, edge: DraftEdge, ends: { source: string; target: string }, direction: LayoutSpec['direction'], ctx: ReturnType<typeof measureContext>): DraftDocument {
  const reversed = ends.source === edge.target && ends.target === edge.source;
  const moved: DraftEdge = { ...edge, source: ends.source, target: ends.target };
  delete moved.sourceAnchor;
  delete moved.targetAnchor;
  delete moved.waypoints;
  if (reversed) {
    // Reversing swaps the anchors with the ends, exactly as `reverseEdge` does — and keeps the line.
    if (edge.targetAnchor) moved.sourceAnchor = edge.targetAnchor;
    if (edge.sourceAnchor) moved.targetAnchor = edge.sourceAnchor;
    if (edge.waypoints) moved.waypoints = [...edge.waypoints].reverse();
  } else {
    // A bent line drawn to the old end would lead the new one the long way round; it routes afresh.
    if (ends.source === edge.source && ends.target === edge.target && edge.waypoints) moved.waypoints = edge.waypoints;
    if (ends.source === edge.source && edge.sourceAnchor) moved.sourceAnchor = edge.sourceAnchor;
    if (ends.target === edge.target && edge.targetAnchor) moved.targetAnchor = edge.targetAnchor;
  }
  let next = reinferIfEligible({ ...view, edges: view.edges.map((e) => (e.id === edge.id ? moved : e)) }, edge.id, view);
  if (reversed) return next;
  const fresh = { ...(next.edges.find((e) => e.id === edge.id) as DraftEdge) };
  const anchors = assignAnchors([fresh], new Map(next.nodes.map((n) => [n.id, anchorRectOf(n)])), direction).get(fresh.id);
  if (anchors && ends.source !== edge.source) fresh.sourceAnchor = anchors.sourceAnchor;
  if (anchors && ends.target !== edge.target) fresh.targetAnchor = anchors.targetAnchor;
  const edges = next.edges.map((e) => (e.id === fresh.id ? fresh : e));
  repairAnchors([fresh], next.nodes, captionSizer(next.nodes, ctx), edges);
  next = { ...next, edges: next.edges.map((e) => (e.id === fresh.id ? fresh : e)) };
  return next;
}

/**
 * A label's `set.style` as a node patch: the fields it names change and the rest stay — `false` and
 * `"none"` turn one off — and `null` makes the whole label plain.
 * Its colour is the label's `color`, which `style.color` sets too.
 */
function labelStylePatch(r: Reader, value: unknown, at: string): Partial<DraftNode> {
  const plain: Partial<DraftNode> = { textRole: undefined, annotation: undefined, textFont: undefined, textBackground: undefined, textAlign: undefined, textBold: undefined, textItalic: undefined };
  if (value === null) return plain;
  const style = readLabelStyle(r, value, at);
  if (!style) return {};
  const given = value as Record<string, unknown>;
  const patch: Partial<DraftNode> = { ...style };
  for (const [key, field] of [['role', 'textRole'], ['font', 'textFont'], ['background', 'textBackground'], ['align', 'textAlign'], ['bold', 'textBold'], ['italic', 'textItalic']] as const) {
    if (given[key] !== undefined && style[field] === undefined) patch[field] = undefined;
  }
  // An explicit role replaces the legacy quiet-label flag, which would otherwise keep winning.
  if (given.role !== undefined) patch.annotation = undefined;
  return patch;
}

/** Which `SET_FIELDS` a node of each type takes: a card's own fields, or an element's. */
const NODE_FIELDS: Partial<Record<DraftNode['type'], keyof typeof SET_FIELDS>> = { group: 'group', note: 'note', code: 'code', text: 'label' };

const isCard = (node: DraftNode) => node.type === 'note' || node.type === 'code' || node.type === 'text';

function updateOne(
  r: Reader,
  view: DraftDocument,
  id: string,
  set: Json,
  at: string,
  ctx: ReturnType<typeof measureContext>,
  touched: Set<string>,
  advisories: string[],
  direction: LayoutSpec['direction'],
  scope?: Scope,
): { view: DraftDocument } | undefined {
  const node = view.nodes.find((n) => n.id === id);
  if (node) {
    refuseOutOfScope(r, at, outOfScope(scope, [id], 'nodes'));
    if (!r.problems.empty) return undefined;
    const card = isCard(node);
    const patch: Partial<DraftNode> = {};
    if (set.evidence !== undefined) patch.evidence = set.evidence === null ? undefined : readEvidence(r, set.evidence, `${at}/evidence`);
    const clear = (field: string) => set[field] === null;
    // A note's or a label's words come as text (or label); an element's or a boundary's name as label.
    const textField = set.text !== undefined ? 'text' : set.label !== undefined ? 'label' : undefined;
    if (textField) {
      const text = r.text(set[textField], `${at}/${textField}`, card ? AGENT_LIMITS.noteLength : AGENT_LIMITS.labelLength, { required: true });
      if (text) Object.assign(patch, { text, textOrigin: 'explicit' });
    }
    if (node.type === 'code') {
      if (set.code !== undefined) {
        const code = r.text(set.code, `${at}/code`, AGENT_LIMITS.codeLength, { required: true, code: true });
        if (code !== undefined) patch.code = code;
      }
      if (set.language !== undefined) {
        const language = r.oneOf(set.language, `${at}/language`, CODE_LANGUAGES);
        if (language) patch.language = language;
      }
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
    if (set.style !== undefined && node.type === 'text') Object.assign(patch, labelStylePatch(r, set.style, `${at}/style`));
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
    if (set.kind !== undefined && card) {
      const form = r.oneOf(set.kind, `${at}/kind`, NOTE_FORM_NAMES);
      if (form && node.type === 'note' && (NOTE_KIND_NAMES as readonly string[]).includes(form)) patch.noteKind = form as (typeof NOTE_KIND_NAMES)[number];
      else if (form && form !== formOf(node)) {
        r.problems.add('UNSUPPORTED', `${at}/kind`, `a ${CARD_NAMES[node.type as AttachableType]} can't become a ${form === 'code' ? 'code snippet' : form === 'label' ? 'label' : 'note'}; remove it and add a new note of kind "${form}"`);
      }
    }
    // A free card folded onto an element, relationship or boundary — the editor's drag-to-attach,
    // keeping the card's id so it is still the same note to the next request.
    if (card && set.attach === true) {
      if (set.group !== undefined) r.problems.add('INVALID_INPUT', `${at}/group`, 'an attachment rides on its host; leave group out, or leave attach out to move it into the boundary');
      if (!r.problems.empty) return undefined;
      const host = attachmentHost(r, view, set.about ?? set.near, `${at}/${set.near !== undefined ? 'near' : 'about'}`, node.type as AttachableType);
      if (!host) return undefined;
      if (node.attachments?.length) r.problems.add('UNSUPPORTED', `${at}/attach`, `"${id}" carries attachments of its own; remove them first`);
      const lines = view.edges.filter((e) => e.source === id || e.target === id).map((e) => e.id);
      if (lines.length) r.problems.add('UNSUPPORTED', `${at}/attach`, `"${id}" has connectors (${lines.map((l) => `"${l}"`).join(', ')}) that would go with it; remove them first`);
      if (host.kind === 'edge' && lines.includes(host.id)) r.problems.add('INVALID_REFERENCE', `${at}/about`, `"${host.id}" is one of "${id}"'s own connectors`);
      if (!r.problems.empty) return undefined;
      const folded = { ...node, ...patch } as DraftNode;
      const attachment = createAttachment({
        id,
        type: node.type as AttachableType,
        ...(folded.text !== undefined && node.type !== 'code' ? { text: folded.text } : {}),
        ...(folded.accent ? { accent: folded.accent } : {}),
        ...(folded.noteKind ? { noteKind: folded.noteKind } : {}),
        ...(folded.language ? { language: folded.language } : {}),
        ...(folded.code !== undefined ? { code: folded.code } : {}),
        width: folded.width,
        height: folded.height,
      });
      // The editor's own order: the card goes (with anything that pointed at it), then folds in.
      const without = removeElements(view, [id]);
      const next = host.kind === 'node' ? attachToNode(without, host.id, attachment) : attachToEdge(without, host.id, attachment);
      if (node.parentId) touched.add(node.parentId);
      touched.add(host.id);
      return { view: next };
    }
    // A free card moved beside another element (placement only), or into a boundary (membership).
    const beside = card ? (set.near ?? set.about) : undefined;
    let besideHost: DraftNode | undefined;
    if (beside !== undefined) {
      const target = typeof beside === 'string' ? view.nodes.find((n) => n.id === beside && n.id !== id) : undefined;
      if (target?.type === 'group') set = { ...set, group: target.id };
      else if (target && !isCard(target)) besideHost = target;
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
    // Source references are metadata: adding one must not resize or judge a manually sized shape.
    const evidenceOnly = Object.keys(set).every((field) => field === 'evidence');
    // Grow (never shrink) to show new text in full — toward whichever side has room. A code card and a
    // label grow to their content the way a paste sizes a new card; neither ever shrinks.
    if (updated.type !== 'group' && !evidenceOnly) {
      const sized =
        updated.type === 'code'
          ? patch.code !== undefined ? naturalCodeSize(updated.code ?? '', ctx) : updated
          : updated.type === 'text'
            ? patch.text !== undefined || set.style !== undefined ? naturalTextSize(updated, updated.text ?? '', ctx, { width: 40, height: DEFAULTS.textHeight }) : updated
            : sizeToFit(updated, ctx);
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
    if (card && typeof set.group === 'string' && set.group !== node.parentId) next = placeInGroup(next, id, set.group);
    else if (patch.parentId !== undefined || set.group !== undefined) next = fitGroups(next, id);
    if (!evidenceOnly) touched.add(id);
    return { view: next };
  }
  const edge = view.edges.find((e) => e.id === id);
  if (edge) {
    refuseOutOfScope(r, at, outOfScope(scope, [id], 'edges'));
    if (!r.problems.empty) return undefined;
    const patch: Partial<DraftEdge> = {};
    if (set.evidence !== undefined) patch.evidence = set.evidence === null ? undefined : readEvidence(r, set.evidence, `${at}/evidence`);
    if (set.label === null) patch.label = undefined;
    else if (set.label !== undefined) patch.label = r.text(set.label, `${at}/label`, AGENT_LIMITS.relationshipLabelLength, { singleLine: true });
    if (set.semantic !== undefined) {
      const semantic = r.oneOf(set.semantic, `${at}/semantic`, EDGE_SEMANTICS);
      if (set.semantic === null) Object.assign(patch, { semantic: undefined, semanticsOrigin: 'explicit' });
      else if (semantic) Object.assign(patch, { semantic, semanticsOrigin: 'explicit' });
    }
    if (set.kind !== undefined) {
      const kind = r.oneOf(set.kind, `${at}/kind`, CONNECTOR_KINDS);
      if (set.kind === null) Object.assign(patch, { kind: undefined, semanticsOrigin: 'explicit' });
      else if (kind) Object.assign(patch, { kind, semanticsOrigin: 'explicit' });
    }
    if (set.directed !== undefined) patch.directed = r.bool(set.directed, `${at}/directed`) ?? edge.directed;
    if (set.async !== undefined) patch.async = r.bool(set.async, `${at}/async`) || undefined;
    if (set.condition === null) patch.condition = undefined;
    else if (set.condition !== undefined) patch.condition = r.text(set.condition, `${at}/condition`, 120, { singleLine: true });
    if (set.color === null) patch.accent = undefined;
    else if (set.color !== undefined) {
      const accent = r.oneOf<Accent>(set.color, `${at}/color`, ACCENTS);
      if (accent) patch.accent = accent;
    }
    if (set.lineStyle !== undefined) {
      const style = r.oneOf(set.lineStyle, `${at}/lineStyle`, LINE_STYLE_NAMES);
      if (style) patch.routing = LINE_STYLES[style];
    }
    const response = readResponse(r, set.response, `${at}/response`);
    const attempts = readDeliveryAttempts(r, set.deliveryAttempts, `${at}/deliveryAttempts`);
    const ends = readEnds(r, view, edge, set, at, patch.semantic ?? edge.semantic);
    if (!r.problems.empty) return undefined;
    // Re-pointed first, as the editor's reconnect is: what the relationship now connects decides what
    // its inferred meaning is, and whether a reply line or delivery attempts belong on it.
    const next = ends ? repoint(view, edge, ends, direction, ctx) : view;
    const current = next.edges.find((e) => e.id === id) as DraftEdge;
    const byId = new Map(next.nodes.map((n) => [n.id, n]));
    if (patch.semantic) {
      const probe = connectorFor({ id, from: current.source, to: current.target, semantic: patch.semantic }, byId.get(current.source) as DraftNode, byId.get(current.target) as DraftNode, advisories);
      if (probe.semantic !== patch.semantic) {
        patch.semantic = current.semantic;
        delete patch.semanticsOrigin;
      }
    }
    // The reply line of a synchronous call — the inspector's "Show response path" and its label.
    if (response === null) Object.assign(patch, { hasResponse: undefined, response: undefined, semanticsOrigin: 'explicit' });
    else if (response !== undefined) {
      const kind = 'kind' in patch ? patch.kind : current.kind;
      const sync = isSyncPairing(resolveTransparentCategory(next, current.source, 'source'), resolveTransparentCategory(next, current.target, 'target')) && (kind === undefined || kind === 'sync');
      if (!sync && !current.hasResponse) {
        r.problems.add('UNSUPPORTED', `${at}/response`, 'a reply line belongs to a synchronous call: a person or a service calling a service, with no behaviour or "sync"');
      } else {
        if (!current.hasResponse) Object.assign(patch, { hasResponse: true, semanticsOrigin: 'explicit' });
        patch.response = response === true ? undefined : response;
      }
    }
    if (attempts === null) patch.deliveryAttempts = undefined;
    else if (attempts !== undefined) {
      const semantic = 'semantic' in patch ? patch.semantic : current.semantic;
      if (semantic !== 'deadLetters') r.problems.add('UNSUPPORTED', `${at}/deliveryAttempts`, 'delivery attempts belong to a dead-letter route (semantic "deadLetters")');
      else patch.deliveryAttempts = attempts;
    }
    if (!r.problems.empty) return undefined;
    if (!Object.keys(set).every((field) => field === 'evidence')) touched.add(id);
    return { view: updateEdge(next, id, patch) };
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
      const steps = flowStepsFor(r, set.steps, `${at}/steps`, existing, lightableIn(view));
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
    return { view: { ...view, flows } };
  }
  const attached = findAttachment(view, id);
  if (attached) {
    refuseOutOfScope(r, at, outOfScope(scope, [attached.hostId], attached.kind === 'node' ? 'nodes' : 'edges'));
    if (!r.problems.empty) return undefined;
    return updateAttachmentOp(r, view, attached, set, at, touched, direction);
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
  // One add places its new elements as one block, so into one existing boundary at most. Elements
  // naming a second one used to land silently in the first.
  const boundaries = [...new Set(intoExisting.map((n) => n.group))];
  if (boundaries.length > 1) {
    throw new AgentError('UNSUPPORTED', `One add op can place new elements into one existing boundary, not ${boundaries.length} (${boundaries.map((g) => `"${g}"`).join(', ')}). Use one add op per boundary; they can go in the same request.`);
  }
  const spec: RoomSpec = {
    ...room,
    // Explicit placement and routing are applied once the block is in the view (`applyUpdate`): they
    // may name what was already there.
    nodes: room.nodes.map(({ place: _place, ...n }) => (n.group && existingIds.has(n.group) ? { ...n, group: undefined } : n)) as RoomSpec['nodes'],
    relationships: inner.map(({ route: _route, ...e }) => e),
    flows: [],
    notes: [],
  };
  // Into an empty view, the flows that come with it say what the main path is (see `arrangeFreshRoom`).
  const fresh = view.nodes.length === 0 && bridging.length === 0;
  const block = spec.nodes.length || spec.groups.length ? (fresh ? arrangeFreshRoom({ ...spec, flows: room.flows }, layout, ctx) : placeRoom(spec, layout, ctx)) : undefined;
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
  next = { ...next, flows: [...next.flows, ...room.flows.map(flowFromSpec)] };
  for (const f of room.flows) {
    if (!f.variantOf) continue;
    next = setFlowVariantOf(next, f.id, f.variantOf);
    if (next.flows.find((flow) => flow.id === f.id)?.variantOf !== f.variantOf) {
      advisories.push(`Flow "${f.id}" was not linked as a variant of "${f.variantOf}": variants are one level deep — a variant's base can't be a variant itself, and a flow with variants can't become one.`);
    }
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
 * An attachment's words, kind or code changed; moved to another element, relationship or boundary
 * (`about`); or taken off its host as a free card (`attach: false`, the editor's Detach) — always
 * with its id, so it is still the same note to the next request.
 */
function updateAttachmentOp(
  r: Reader,
  view: DraftDocument,
  found: FoundAttachment,
  set: Json,
  at: string,
  touched: Set<string>,
  direction: LayoutSpec['direction'],
): { view: DraftDocument } | undefined {
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
    const form = r.oneOf(set.kind, `${at}/kind`, NOTE_FORM_NAMES);
    if (form && attachment.type === 'note' && (NOTE_KIND_NAMES as readonly string[]).includes(form)) patch.noteKind = form as (typeof NOTE_KIND_NAMES)[number];
    else if (form && form !== formOf(attachment)) {
      r.problems.add('UNSUPPORTED', `${at}/kind`, `a ${CARD_NAMES[attachment.type]} attachment can't become a ${form === 'code' ? 'code snippet' : form === 'label' ? 'label' : 'note'}; remove it and add a new note of kind "${form}"`);
    }
  }
  if (set.code !== undefined || set.language !== undefined) {
    if (!isCode) r.problems.add('UNSUPPORTED', `${at}/code`, 'only a code attachment has code');
    else {
      if (set.code !== undefined) {
        const code = r.text(set.code, `${at}/code`, AGENT_LIMITS.codeLength, { required: true, code: true });
        if (code !== undefined) patch.code = code;
      }
      if (set.language !== undefined) {
        const language = r.oneOf(set.language, `${at}/language`, CODE_LANGUAGES);
        if (language) patch.language = language;
      }
    }
  }
  const detach = r.bool(set.attach, `${at}/attach`) === false;
  let move: { kind: 'node' | 'edge'; id: string } | undefined;
  let landing: DraftNode | undefined;
  if (detach && set.about !== undefined) {
    // Where the free card lands: beside an element, or inside a boundary.
    landing = typeof set.about === 'string' ? view.nodes.find((n) => n.id === set.about && !isCard(n)) : undefined;
    if (!landing) r.problems.add('INVALID_REFERENCE', `${at}/about`, `no element or boundary "${String(set.about)}" to put it beside or in`);
  } else if (set.about !== undefined && set.about !== hostId) {
    move = attachmentHost(r, view, set.about, `${at}/about`, attachment.type);
  }
  if (!r.problems.empty) return undefined;
  let next = kind === 'node' ? updateAttachment(view, hostId, attachment.id, patch) : updateEdgeAttachment(view, hostId, attachment.id, patch);
  touched.add(hostId);
  if (detach) {
    const result = kind === 'node' ? detachFromNode(next, hostId, attachment.id) : detachFromEdge(next, hostId, attachment.id);
    const extracted = result.extractedNode;
    if (!extracted) {
      r.problems.add('INVALID_INPUT', `${at}/attach`, `"${attachment.id}" can't be taken off "${hostId}"`);
      return undefined;
    }
    // The card keeps the attachment's id: it is the same note, now on the canvas.
    next = { ...result.doc, nodes: result.doc.nodes.map((n) => (n.id === extracted.id ? { ...n, id: attachment.id } : n)) };
    if (landing?.type === 'group') next = placeInGroup(next, attachment.id, landing.id);
    else {
      const edge = kind === 'edge' ? next.edges.find((e) => e.id === hostId) : undefined;
      const besides = landing ? [landing] : edge ? [edge.source, edge.target].flatMap((end) => next.nodes.filter((n) => n.id === end)) : next.nodes.filter((n) => n.id === hostId);
      let placed: DraftDocument | undefined;
      for (const host of besides) if (!placed) placed = placeBeside(next, attachment.id, host, direction);
      if (placed) next = placed;
      else {
        const card = next.nodes.find((n) => n.id === attachment.id)!;
        const free = freeOriginFor({ ...next, nodes: next.nodes.filter((n) => n.id !== card.id) }, card);
        next = updateNode(next, card.id, { x: Math.round(free.x), y: Math.round(free.y) });
      }
    }
    touched.add(attachment.id);
    return { view: next };
  }
  if (move) {
    const current = findAttachment(next, attachment.id)!.attachment;
    next = kind === 'node' ? removeAttachment(next, hostId, attachment.id) : removeEdgeAttachment(next, hostId, attachment.id);
    next = move.kind === 'node' ? attachToNode(next, move.id, current) : attachToEdge(next, move.id, current);
    touched.add(move.id);
  }
  return { view: next };
}

/**
 * A flow's new step list, read against the steps it has, in the forms `read_diagram` writes:
 *
 * - a relationship id, or `{relationship, caption?, highlight?, pinnedView?}`: a step whose
 *   relationship was already a step keeps that step — its id, extra highlights, camera and caption —
 *   unless the field says otherwise (`caption: null` clears it, `highlight` replaces the extras and
 *   `null` clears them);
 * - `{frame: <step id>, caption?, spotlight?, pinnedView?}`: keeps a step with no relationship, with
 *   the same field rules (`spotlight` is that step's extras);
 * - `{spotlight: [ids], caption?}`: a new step with no relationship, lighting just those.
 *
 * `pinnedView: false` drops a camera a person pinned on the step (the Flows panel's Pin view), so the
 * presentation frames what it lights again; `true` only keeps one — a view is pinned in the app.
 */
function flowStepsFor(r: Reader, raw: unknown, at: string, flow: DraftFlow, known: Lightable): DraftFlowStep[] | undefined {
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
  /** `caption`, the extras (`field`) and `pinnedView` applied to `base`; false when refused. */
  const details = (step: Json, stepAt: string, base: DraftFlowStep, field: 'highlight' | 'spotlight'): boolean => {
    if (step.caption === null) delete base.caption;
    else if (step.caption !== undefined) {
      const caption = r.text(step.caption, `${stepAt}/caption`, AGENT_LIMITS.captionLength, { singleLine: true });
      if (caption) base.caption = caption;
    }
    if (step[field] === null) {
      delete base.extraNodeIds;
      delete base.extraEdgeIds;
    } else if (step[field] !== undefined) {
      const lit = readHighlight(r, step[field], `${stepAt}/${field}`, known, base.edgeId);
      if (!lit) return false;
      delete base.extraNodeIds;
      delete base.extraEdgeIds;
      Object.assign(base, extrasOf(lit));
    }
    if (step.pinnedView !== undefined) {
      const pinned = r.bool(step.pinnedView, `${stepAt}/pinnedView`);
      if (pinned === false) delete base.viewport;
      else if (pinned && !base.viewport) {
        r.problems.add('INVALID_INPUT', `${stepAt}/pinnedView`, 'only a person pins a camera view, in the app; leave pinnedView out (the presentation frames what the step lights)');
        return false;
      }
    }
    return true;
  };
  items.forEach((item, j) => {
    const stepAt = `${at}/${j}`;
    const step = typeof item === 'string' ? { relationship: item } : r.object(item, stepAt);
    if (!step) return;
    if (step.frame !== undefined || step.spotlight !== undefined || step.relationship === undefined) {
      r.fields(step, stepAt, ['frame', 'spotlight', 'caption', 'pinnedView']);
      let base: DraftFlowStep;
      if (step.frame !== undefined) {
        const frame = typeof step.frame === 'string' ? unused.find((s) => s.id === step.frame && !s.edgeId) : undefined;
        if (!frame) {
          r.problems.add('INVALID_REFERENCE', `${stepAt}/frame`, `no frame step "${String(step.frame)}" in this flow`);
          return;
        }
        unused.splice(unused.indexOf(frame), 1);
        base = { ...frame };
      } else if (step.spotlight === undefined) {
        r.problems.add('INVALID_INPUT', `${stepAt}/relationship`, 'is required (or spotlight: the ids a step lights without a relationship)');
        return;
      } else {
        if (step.pinnedView === true) {
          r.problems.add('INVALID_INPUT', `${stepAt}/pinnedView`, 'only a person pins a camera view, in the app; leave pinnedView out');
          return;
        }
        base = { id: newId() };
      }
      if (!details(step, stepAt, base, 'spotlight')) return;
      // A step that lights nothing is skipped by the presentation; refuse it rather than store it.
      if (!base.extraNodeIds?.length && !base.extraEdgeIds?.length && !base.viewport) {
        r.problems.add('INVALID_INPUT', `${stepAt}/spotlight`, 'a step without a relationship needs at least one id to light');
        return;
      }
      out.push(base);
      return;
    }
    r.fields(step, stepAt, ['relationship', 'caption', 'highlight', 'pinnedView']);
    const relationship = typeof step.relationship === 'string' ? step.relationship : undefined;
    if (!relationship || !known.relationshipIds.has(relationship)) {
      r.problems.add('INVALID_REFERENCE', `${stepAt}/relationship`, relationship ? `no relationship "${relationship}" in this view` : 'must be a relationship id');
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
    if (details(step, stepAt, base, 'highlight')) out.push(base);
  });
  return out;
}

/** `next`, with every node and connector it changed against `view` marked touched — what moved
 *  along with an explicit placement (a group's contents, a note beside it) is judged with it. */
function touchedBy(view: DraftDocument, next: DraftDocument, touched: Set<string>): DraftDocument {
  if (next === view) return view;
  const nodes = new Map(view.nodes.map((n) => [n.id, n]));
  const edges = new Map(view.edges.map((e) => [e.id, e]));
  for (const node of next.nodes) if (nodes.get(node.id) !== node) touched.add(node.id);
  for (const edge of next.edges) if (edges.get(edge.id) !== edge) touched.add(edge.id);
  return next;
}

/** A hand-routed connector handed back to the layout: no bends, and anchored afresh from where both
 *  of its shapes are now — what `repoint` does for a moved end. */
function automaticRoute(view: DraftDocument, id: string, direction: LayoutSpec['direction'], ctx: ReturnType<typeof measureContext>): DraftDocument {
  const edge = view.edges.find((e) => e.id === id);
  if (!edge) return view;
  const fresh: DraftEdge = { ...edge };
  delete fresh.waypoints;
  delete fresh.sourceAnchor;
  delete fresh.targetAnchor;
  const anchors = assignAnchors([fresh], new Map(view.nodes.map((n) => [n.id, anchorRectOf(n)])), direction).get(id);
  if (anchors) Object.assign(fresh, anchors);
  const edges = view.edges.map((e) => (e.id === id ? fresh : e));
  repairAnchors([fresh], view.nodes, captionSizer(view.nodes, ctx), edges);
  return { ...view, edges: view.edges.map((e) => (e.id === id ? fresh : e)) };
}
