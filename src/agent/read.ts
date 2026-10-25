/**
 * `read_diagram`: one view of a diagram as meaning, not geometry — elements with their type, name,
 * C4 detail and derived C4 classification, boundaries, relationships, flows, notes and actions.
 *
 * Bounded by default: one room (a view), a page of elements, a byte ceiling. Nested views appear as
 * references (their owner, level and size) to read next, never expanded wholesale. A partial answer
 * says so, names what lies across its edge, and hands back a cursor tied to the revision it was
 * read at — so a page read after someone else's edit is refused rather than silently mismatched.
 *
 * Everything returned is the person's text, untrusted: agents are told so in the server's
 * instructions, and nothing here ever phrases document content as an instruction.
 */

import { continuationsFor } from '../continuation';
import { classify } from '../depth/c4';
import { effectiveLevel } from '../depth/level';
import { canCreateInside, hasInside, ownerAt, resolvePath, roomsOf, viewOf, type DepthPath } from '../depth/tree';
import { relationshipCaptionLabel } from '../document/edgeSemantics';
import { categoryOf } from '../document/connectorSemantics';
import type { Attachment, DraftDocument, DraftEdge, DraftFlowStep, DraftNode } from '../document/types';
import { AgentError } from './errors';
import { reviewView, type ReviewFinding } from './review';
import { groupKindOf, lineStyleOf, typeWordOf } from './vocabulary';
import { routeGeometry } from './route';

export const READ_LIMITS = {
  elementsPerPage: 200,
  relationshipsPerPage: 400,
  flows: 20,
  bytes: 96 * 1024,
  noteText: 400,
  suggestionsPerElement: 5,
  suggestionElements: 20,
  views: 100,
} as const;

const INCLUDES = ['geometry', 'attachments', 'suggestions', 'fullText', 'views'] as const;
type Include = (typeof INCLUDES)[number];

export interface ReadArgs {
  view?: { inside?: unknown };
  focus?: { nodes?: unknown; group?: unknown; flow?: unknown };
  include?: unknown;
  cursor?: unknown;
}

export function viewPathOf(file: DraftDocument, view: unknown): DepthPath {
  if (view === undefined || view === null) return [];
  const inside = (view as { inside?: unknown }).inside;
  if (inside === undefined) return [];
  if (!Array.isArray(inside) || inside.some((id) => typeof id !== 'string') || inside.length > 3) {
    throw new AgentError('INVALID_INPUT', 'view.inside must be the path of element ids to the view, outermost first (at most 3).', { path: '/view/inside' });
  }
  const path = inside as string[];
  const resolved = resolvePath(file, path);
  if (resolved.length !== path.length) {
    throw new AgentError('NOT_FOUND', `No inside view at ${path.join(' ▸ ')}.`, {
      path: '/view/inside',
      hint: 'Read the outer view first: an element with an inside view lists it under "inside". A service or component without one gets one from the first update_diagram add with view.inside naming it.',
    });
  }
  // A shape with nothing inside yet has an empty inside view — but only one "Look inside" is offered
  // on: a service or a (non-port) component. Anything else would hold a room the editor can't open.
  const owner = path.length ? ownerAt(file, path) : undefined;
  if (owner && !hasInside(owner) && !canCreateInside(owner)) {
    throw new AgentError('NOT_FOUND', `"${owner.id}" has no inside view, and can't have one: only a service or a (non-port) component holds the next level down.`, {
      path: '/view/inside',
      hint: 'Draw its detail inside the service or component that owns it, or as elements in this view.',
    });
  }
  return path;
}

/** Every inside view of the file — the Depth map's outline, for finding one to read. */
function viewsOutline(file: DraftDocument) {
  const rooms = roomsOf(file).filter((room) => room.path.length > 0);
  return {
    views: rooms.slice(0, READ_LIMITS.views).map((room) => {
      const owner = room.owners[room.owners.length - 1]!;
      return {
        inside: [...room.path],
        owner: { id: owner.id, label: owner.text ?? '', type: typeWordOf(owner) },
        level: effectiveLevel(file, room.path) ?? null,
        elements: room.graph.nodes.length,
        relationships: room.graph.edges.length,
        flows: room.graph.flows.length,
      };
    }),
    ...(rooms.length > READ_LIMITS.views ? { viewsTruncated: true } : {}),
  };
}

/**
 * A flow step as `update_diagram` takes it back: a bare relationship id; the object form when it says
 * more (a caption, extra highlights, a camera a person pinned); or, for a step with no relationship,
 * `{frame, spotlight?, caption?, pinnedView?}`. Sent back unchanged, it changes nothing.
 */
export function stepOf(step: DraftFlowStep): unknown {
  const lit = [...(step.extraNodeIds ?? []), ...(step.extraEdgeIds ?? [])];
  const rest = { ...(step.caption ? { caption: step.caption } : {}), ...(step.viewport ? { pinnedView: true } : {}) };
  if (!step.edgeId) return { frame: step.id, ...(lit.length ? { spotlight: lit } : {}), ...rest };
  return lit.length || step.caption || step.viewport ? { relationship: step.edgeId, ...(lit.length ? { highlight: lit } : {}), ...rest } : step.edgeId;
}

function truncated(text: string, max: number): { text: string; truncated?: true } {
  const chars = [...text];
  return chars.length > max ? { text: `${chars.slice(0, max).join('')}…`, truncated: true } : { text };
}

export function readDiagram(file: DraftDocument, args: ReadArgs, revision: string, diagramId: string): Record<string, unknown> {
  const path = viewPathOf(file, args.view);
  const view = path.length ? viewOf(file, path) : file;
  if (!view) throw new AgentError('NOT_FOUND', 'That view no longer exists.');
  const includes = new Set<Include>(
    Array.isArray(args.include) ? (args.include as unknown[]).filter((i): i is Include => (INCLUDES as readonly unknown[]).includes(i)) : [],
  );
  const level = effectiveLevel(file, path);
  const ownLevel = view.level;
  const owner = path.length ? findOwner(file, path) : undefined;
  const byId = new Map(view.nodes.map((n) => [n.id, n]));

  // What the caller scoped the read to.
  let scope: Set<string> | undefined;
  const focus = args.focus;
  if (focus) {
    scope = new Set<string>();
    if (Array.isArray(focus.nodes)) for (const id of focus.nodes) if (typeof id === 'string' && byId.has(id)) scope.add(id);
    if (typeof focus.group === 'string') {
      if (!byId.has(focus.group)) throw new AgentError('NOT_FOUND', `No group "${focus.group}" in this view.`, { path: '/focus/group' });
      scope.add(focus.group);
      for (const node of view.nodes) if (ancestorsOf(node, byId).has(focus.group)) scope.add(node.id);
    }
    if (typeof focus.flow === 'string') {
      const flow = view.flows.find((f) => f.id === focus.flow);
      if (!flow) throw new AgentError('NOT_FOUND', `No flow "${focus.flow}" in this view.`, { path: '/focus/flow' });
      const edges = new Map(view.edges.map((e) => [e.id, e]));
      for (const step of flow.steps) {
        const edge = step.edgeId ? edges.get(step.edgeId) : undefined;
        if (edge) {
          scope.add(edge.source);
          scope.add(edge.target);
        }
        for (const id of step.extraNodeIds ?? []) scope.add(id);
        for (const id of step.extraEdgeIds ?? []) {
          const lit = edges.get(id);
          if (lit) {
            scope.add(lit.source);
            scope.add(lit.target);
          }
        }
      }
    }
  }

  const all = view.nodes.filter((n) => !scope || scope.has(n.id));
  const signature = fingerprint(JSON.stringify({ diagramId, focus: args.focus ? { nodes: Array.isArray(args.focus.nodes) ? [...new Set(args.focus.nodes)].sort() : null, group: args.focus.group ?? null, flow: args.focus.flow ?? null } : null, include: [...includes].sort() }));
  const offsets = cursorOffsets(args.cursor, revision, path, signature);
  // What the view's own semantics say a pattern is missing (`review.ts`) — on the first page only, and
  // for a focused read only the findings about what it is focused on.
  const review = offsets.every((offset) => offset === 0)
    ? reviewView(view.nodes, view.edges, { level, nested: path.length > 0 }).filter((finding) => !scope || finding.ids.some((id) => scope.has(id)))
    : [];
  // Fitting a UTF-8 page may project it several times. Route each connector once for this snapshot.
  const geometryCache = new Map<string, ReturnType<typeof routeGeometry>>();
  const sizes = [READ_LIMITS.elementsPerPage, READ_LIMITS.relationshipsPerPage, READ_LIMITS.flows, 50];
  // Every collection has its own offset. Reducing elements alone cannot bound a response full of flows.
  for (;;) {
    const page = all.slice(offsets[0], offsets[0]! + sizes[0]!);
    const result = project(file, view, page, all, path, level, ownLevel, owner, includes, revision, diagramId, offsets, sizes, scope !== undefined, signature, args.focus, geometryCache, review);
    if (new TextEncoder().encode(JSON.stringify(result)).length <= READ_LIMITS.bytes) return result;
    if (sizes.every((size) => size <= 1)) {
      // Several individually bounded items can exceed the ceiling together. A page may exhaust
      // just one collection; its cursor still advances and carries the other offsets unchanged.
      for (let collection = 0; collection < sizes.length; collection += 1) {
        const one = sizes.map((_size, index) => index === collection ? 1 : 0);
        const single = project(file, view, all.slice(offsets[0], offsets[0]! + one[0]!), all, path, level, ownLevel, owner, includes, revision, diagramId, offsets, one, scope !== undefined, signature, args.focus, geometryCache, review);
        const progress = ['elements', 'groups', 'notes', 'relationships', 'flows', 'openPoints'].some((key) => Array.isArray(single[key]) && (single[key] as unknown[]).length > 0);
        if (progress && new TextEncoder().encode(JSON.stringify(single)).length <= READ_LIMITS.bytes) return single;
      }
      throw new AgentError('LIMIT_EXCEEDED', 'One item exceeds the read response limit.', { hint: 'Read fewer fields or omit fullText; use read_attachment for long attachment bodies.' });
    }
    for (let i = 0; i < sizes.length; i += 1) sizes[i] = Math.max(1, Math.floor(sizes[i]! / 2));
  }
}

function findOwner(file: DraftDocument, path: DepthPath): DraftNode | undefined {
  let nodes = file.nodes;
  let owner: DraftNode | undefined;
  for (const id of path) {
    owner = nodes.find((n) => n.id === id);
    nodes = owner?.inside?.nodes ?? [];
  }
  return owner;
}

function ancestorsOf(node: DraftNode, byId: Map<string, DraftNode>): Set<string> {
  const out = new Set<string>();
  let at = node.parentId;
  while (at && !out.has(at)) {
    out.add(at);
    at = byId.get(at)?.parentId;
  }
  return out;
}

/**
 * A short fingerprint of a read's focus and options, which a page cursor carries in place of the options
 * themselves: a focus of 200 ids made a cursor of about 5 KB (JSON inside JSON, percent-encoded) that
 * went out to the agent and came back with every page. A collision only lets a cursor from a different
 * focus of the same diagram revision through, which then reads from its offsets.
 */
function fingerprint(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function cursorOffsets(cursor: unknown, revision: string, path: DepthPath, signature: string): number[] {
  if (cursor === undefined || cursor === null) return [0, 0, 0, 0];
  let payload: { revision?: unknown; path?: unknown; signature?: unknown; offsets?: unknown };
  try { payload = JSON.parse(decodeURIComponent(String(cursor))); }
  catch { throw new AgentError('INVALID_INPUT', 'That cursor is not a diagram cursor.', { path: '/cursor' }); }
  if (!payload || typeof payload !== 'object') throw new AgentError('INVALID_INPUT', 'That cursor is not a diagram cursor.', { path: '/cursor' });
  if (payload.revision !== revision || JSON.stringify(payload.path) !== JSON.stringify(path) || payload.signature !== signature) {
    throw new AgentError('CURSOR_STALE', 'The revision, view or read options changed since that page was read.', { hint: 'Read again from the start with the same focus and include options.', details: { revision } });
  }
  if (!Array.isArray(payload.offsets) || payload.offsets.length !== 4 || payload.offsets.some((n) => !Number.isSafeInteger(n) || n < 0)) throw new AgentError('INVALID_INPUT', 'Invalid cursor offsets.', { path: '/cursor' });
  return payload.offsets;
}

function project(
  file: DraftDocument,
  view: DraftDocument,
  page: DraftNode[],
  all: DraftNode[],
  path: DepthPath,
  level: ReturnType<typeof effectiveLevel>,
  ownLevel: DraftDocument['level'],
  owner: DraftNode | undefined,
  includes: Set<Include>,
  revision: string,
  diagramId: string,
  offsets: number[],
  sizes: number[],
  focused: boolean,
  signature: string,
  focus: ReadArgs['focus'],
  geometryCache: Map<string, ReturnType<typeof routeGeometry>>,
  review: readonly ReviewFinding[],
): Record<string, unknown> {
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  const inPage = new Set(page.map((n) => n.id));
  const elements: unknown[] = [];
  const groups: unknown[] = [];
  const notes: unknown[] = [];
  for (const node of page) {
    const geometry = includes.has('geometry') ? { geometry: { x: node.x, y: node.y, width: node.width, height: node.height } } : {};
    const group = node.parentId ? { group: node.parentId } : {};
    // In full when asked for, or when the read is focused on a few elements (their notes are part of
    // what the agent is about to edit); a count otherwise.
    const attachments = node.attachments?.length
      ? includes.has('attachments') || includes.has('fullText') || focused
        ? { attachments: node.attachments.map((a) => attachmentOf(a, includes.has('fullText'))) }
        : { attachmentCount: node.attachments.length }
      : {};
    if (node.type === 'group') {
      groups.push({ id: node.id, label: node.text ?? '', kind: groupKindOf(node.boundaryPreset), ...(node.parentId ? { parent: node.parentId } : {}), ...attachments, ...geometry });
      continue;
    }
    if (node.type === 'note' || node.type === 'text' || node.type === 'code') {
      const body = node.type === 'code' ? truncated(node.code ?? '', (includes.has('fullText') ? Infinity : READ_LIMITS.noteText)) : truncated(node.text ?? '', includes.has('fullText') ? Infinity : READ_LIMITS.noteText);
      // A free note records no link to anything; `nearest` is only where it sits, said as such.
      const nearest = node.parentId ? undefined : nearestElement(node, view.nodes);
      notes.push({
        id: node.id,
        kind: node.type === 'note' ? (node.noteKind ?? 'note') : node.type === 'code' ? 'code' : 'label',
        ...(node.type === 'code' ? { language: node.language, code: body.text } : { text: body.text }),
        ...(body.truncated ? { truncated: true } : {}),
        ...(node.accent ? { color: node.accent } : {}),
        ...(node.type === 'text' ? labelStyleOf(node) : {}),
        ...group,
        ...(nearest ? { nearest } : {}),
        ...geometry,
      });
      continue;
    }
    const systemBoundary = [...ancestorsOf(node, byId)].map((id) => byId.get(id)).find((g) => g?.boundaryPreset === 'system');
    const c4 = classify(node, { level, ...(owner ? { insideOwner: owner } : {}), ...(systemBoundary ? { systemBoundary } : {}) });
    const inside = hasInside(node) && node.inside
      ? { inside: { level: node.inside.level ?? null, elements: node.inside.nodes.length, relationships: node.inside.edges.length } }
      : {};
    elements.push({
      id: node.id,
      type: typeWordOf(node),
      label: node.text ?? '',
      ...(node.evidence?.length ? { evidence: node.evidence } : {}),
      ...(node.description ? { description: node.description } : {}),
      ...(node.technology ? { technology: node.technology } : {}),
      ...group,
      // "No role, no scope" is what every element says before a level is set: not worth ~80 bytes each.
      ...(c4 && (c4.role !== 'unspecified' || c4.scope !== 'unspecified') ? { c4 } : {}),
      ...inside,
      ...attachments,
      ...geometry,
    });
  }

  // Relationships touching the page; an end outside it is described enough to be unambiguous.
  const relationships: unknown[] = [];
  const outside = new Map<string, unknown>();
  const allIds = new Set(all.map((n) => n.id));
  const allRelationships = view.edges.filter((edge) => allIds.has(edge.source) || allIds.has(edge.target));
  const edgePage = allRelationships.slice(offsets[1], offsets[1]! + sizes[1]!);
  for (const edge of edgePage) {
    const s = inPage.has(edge.source);
    const t = inPage.has(edge.target);
    if (includes.has('geometry') && !geometryCache.has(edge.id)) geometryCache.set(edge.id, routeGeometry(edge, view.nodes, view.edges, byId));
    const geometry = geometryCache.get(edge.id);
    relationships.push({
      ...relationshipOf(edge, byId, includes.has('attachments') || includes.has('fullText') || focused, includes.has('fullText')),
      // Its sides and the points where it turns, as drawn; `via` are the bends it was given by hand.
      ...(geometry ? { geometry: { ...geometry, ...(edge.waypoints ? { via: edge.waypoints.map((p) => [p.x, p.y]) } : {}) } } : {}),
    });
    for (const [end, here] of [[edge.source, s], [edge.target, t]] as const) {
      if (here) continue;
      const node = byId.get(end);
      if (node) outside.set(end, { id: end, type: typeWordOf(node), label: node.text ?? '' });
    }
  }

  const suggestions: Record<string, string[]> = {};
  if (includes.has('suggestions')) {
    for (const node of page.slice(0, READ_LIMITS.suggestionElements)) {
      try {
        const offers = continuationsFor(view, node.id, 'invoke', { ...(level ? { level } : {}) });
        if (offers.length) suggestions[node.id] = offers.slice(0, READ_LIMITS.suggestionsPerElement).map((o) => o.actionLabel);
      } catch {
        // Suggestions are a courtesy; a rule that can't read an unusual view says nothing.
      }
    }
  }

  const allFlows = typeof focus?.flow === 'string' ? view.flows.filter((f) => f.id === focus.flow) : view.flows;
  const here = new Set([...view.nodes.map((n) => n.id), ...view.edges.map((e) => e.id)]);
  const allPoints = (file.openPoints ?? []).filter((p) => (path.length === 0 || p.targets.some((t) => here.has(t.id))) && (!focused || p.targets.some((t) => allIds.has(t.id) || allRelationships.some((e) => e.id === t.id))));
  const totals = [all.length, allRelationships.length, allFlows.length, allPoints.length];
  const next = totals.map((total, i) => Math.min(total, offsets[i]! + sizes[i]!));
  const complete = next.every((offset, i) => offset >= totals[i]!);
  const partial = focused || !complete || offsets.some((offset) => offset > 0);
  const result: Record<string, unknown> = {
    diagramId,
    title: file.metadata.title,
    revision,
    view: {
      path: [...path],
      ...(owner ? { owner: { id: owner.id, label: owner.text ?? '', type: typeWordOf(owner) } } : {}),
      level: level ?? null,
      ...(level && ownLevel === undefined ? { levelInherited: true } : {}),
      // An inside view nothing has been drawn in yet: the first add with this view creates it.
      ...(owner && view.nodes.length === 0 ? { empty: true } : {}),
      insideViews: page.filter((n) => hasInside(n)).map((n) => n.id),
    },
    ...(includes.has('views') ? viewsOutline(file) : {}),
    elements,
    relationships,
    ...(groups.length ? { groups } : {}),
    ...(notes.length ? { notes } : {}),
    flows: allFlows.slice(offsets[2], offsets[2]! + sizes[2]!).map((f) => ({
      id: f.id,
      title: f.title,
      ...(f.variantOf ? { variantOf: f.variantOf } : {}),
      ...(f.accent ? { color: f.accent } : {}),
      // As update_diagram takes them back — see `stepOf`.
      steps: f.steps.map(stepOf),
    })),
    // What the people have not settled yet — every point at the root, and in a nested view the ones
    // about something in it. Read as data an agent may act on when asked; nothing here is a request.
    ...(() => {
      const points = allPoints.slice(offsets[3], offsets[3]! + sizes[3]!);
      return points.length
        ? {
            openPoints: points.map((p) => ({
              id: p.id,
              kind: p.kind,
              ...(p.context ? { context: p.context } : {}),
              about: p.targets.map((t) => t.id),
              ...(p.resolved ? { resolved: true } : {}),
              ...(p.resolution ? { resolution: p.resolution } : {}),
            })),
          }
        : {};
    })(),
    ...(Object.keys(suggestions).length ? { suggestions } : {}),
    // Facts read from the semantics, not requests: what to do about each is the person's call.
    ...(review.length ? { review } : {}),
    ...(outside.size ? { outsideEndpoints: [...outside.values()] } : {}),
  };
  if (partial) {
    result.partial = true;
    result.counts = { elements: all.length, relationships: allRelationships.length, flows: allFlows.length, openPoints: allPoints.length };
  }
  result.completeness = { elements: next[0]! >= totals[0]!, relationships: next[1]! >= totals[1]!, flows: next[2]! >= totals[2]!, openPoints: next[3]! >= totals[3]! };
  if (!complete) result.cursor = encodeURIComponent(JSON.stringify({ revision, path, signature, offsets: next }));
  return result;
}

export function attachmentOf(a: Attachment, fullText = false) {
  const body = truncated(a.type === 'code' ? a.code ?? '' : a.text ?? '', fullText ? Infinity : READ_LIMITS.noteText);
  return {
    id: a.id,
    kind: a.type,
    ...(body.truncated ? { truncated: true, characters: [...(a.type === 'code' ? a.code ?? '' : a.text ?? '')].length } : {}),
    ...(a.type === 'code'
      ? { language: a.language, code: body.text }
      : { ...(a.noteKind ? { noteKind: a.noteKind } : {}), text: body.text }),
  };
}

/** The element a free note sits closest to (edge to edge), within a short reach — or none. */
export function nearestElement(note: DraftNode, nodes: readonly DraftNode[]): string | undefined {
  const REACH = 160;
  let best: { id: string; gap: number } | undefined;
  for (const n of nodes) {
    if (n.id === note.id || n.type === 'group' || n.type === 'note' || n.type === 'text' || n.type === 'code') continue;
    const dx = Math.max(0, n.x - (note.x + note.width), note.x - (n.x + n.width));
    const dy = Math.max(0, n.y - (note.y + note.height), note.y - (n.y + n.height));
    const gap = Math.hypot(dx, dy);
    if (gap <= REACH && (!best || gap < best.gap)) best = { id: n.id, gap };
  }
  return best?.id;
}

export function relationshipOf(edge: DraftEdge, byId: Map<string, DraftNode>, withAttachments = false, fullText = false) {
  const source = byId.get(edge.source);
  const target = byId.get(edge.target);
  const caption =
    !edge.label && edge.semantic && source && target
      ? relationshipCaptionLabel(edge.semantic, { source: categoryOf(source), target: categoryOf(target) })
      : undefined;
  return {
    id: edge.id,
    from: edge.source,
    to: edge.target,
    ...(edge.evidence?.length ? { evidence: edge.evidence } : {}),
    ...(edge.label ? { label: edge.label } : {}),
    ...(caption ? { caption } : {}),
    ...(edge.semantic ? { semantic: edge.semantic } : {}),
    ...(edge.kind ? { kind: edge.kind } : {}),
    ...(edge.directed === false ? { directed: false } : {}),
    ...(edge.async ? { async: true } : {}),
    ...(edge.condition ? { condition: edge.condition } : {}),
    ...(edge.accent ? { color: edge.accent } : {}),
    ...(edge.routing !== 'smoothstep' ? { lineStyle: lineStyleOf(edge.routing) } : {}),
    ...(edge.hasResponse ? { response: edge.response ?? true } : {}),
    ...(edge.deliveryAttempts !== undefined ? { deliveryAttempts: edge.deliveryAttempts } : {}),
    ...(edge.compensationFor ? { compensationFor: edge.compensationFor } : {}),
    ...(edge.compensationVisible !== undefined ? { compensationVisible: edge.compensationVisible } : {}),
    ...(edge.compensationName ? { compensationName: edge.compensationName } : {}),
    ...(edge.compensationProtocol ? { compensationProtocol: edge.compensationProtocol } : {}),
    ...(edge.compensationDescription ? { compensationDescription: edge.compensationDescription } : {}),
    ...(edge.attachments?.length ? (withAttachments ? { attachments: edge.attachments.map((a) => attachmentOf(a, fullText)) } : { attachmentCount: edge.attachments.length }) : {}),
  };
}

/** Complete attachment retrieval in bounded Unicode chunks, tied to the revision being read. */
export function readAttachment(file: DraftDocument, args: { attachmentId?: unknown; view?: unknown; expectedRevision?: unknown; offset?: unknown }, revision: string, diagramId: string) {
  if (args.expectedRevision !== revision) throw new AgentError('REVISION_CONFLICT', 'The diagram changed since the attachment was read. Start again at offset 0 with the current revision.');
  const path = viewPathOf(file, args.view);
  const room = viewOf(file, path)!;
  const offset = args.offset === undefined ? 0 : args.offset;
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) throw new AgentError('INVALID_INPUT', 'offset must be a non-negative integer.');
  for (const host of [...room.nodes, ...room.edges]) {
    const attachment = host.attachments?.find((a) => a.id === args.attachmentId);
    if (!attachment) continue;
    const characters = [...(attachment.type === 'code' ? attachment.code ?? '' : attachment.text ?? '')];
    if (offset > characters.length) throw new AgentError('INVALID_INPUT', 'offset is beyond this attachment.');
    const end = Math.min(characters.length, offset + 8192);
    const content = characters.slice(offset, end).join('');
    return { diagramId, revision, view: { path }, attachmentId: attachment.id, hostId: host.id, kind: attachment.type, offset, nextOffset: end < characters.length ? end : null, totalCharacters: characters.length, ...(attachment.type === 'code' ? { code: content, language: attachment.language } : { text: content, noteKind: attachment.noteKind }) };
  }
  throw new AgentError('NOT_FOUND', 'No attachment with that id exists in this view.');
}

/** A label's look, in `style`'s own words — only what differs from a plain label. */
function labelStyleOf(node: DraftNode): { style?: Record<string, string | boolean> } {
  const style: Record<string, string | boolean> = {};
  if (node.textRole) style.role = node.textRole;
  else if (node.annotation) style.role = 'label';
  if (node.textFont) style.font = node.textFont;
  if (node.textBackground) style.background = node.textBackground;
  if (node.textAlign && node.textAlign !== 'left') style.align = node.textAlign;
  if (node.textBold) style.bold = true;
  if (node.textItalic) style.italic = true;
  return Object.keys(style).length > 0 ? { style } : {};
}
