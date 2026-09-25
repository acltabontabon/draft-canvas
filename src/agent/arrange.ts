/**
 * `{op:"arrange"}`: the arrangement a new diagram gets (`arrangeParts`), applied to what is already
 * there — what "clean up the arrows and spacing" means. It moves shapes and re-chooses connector
 * anchors, only within its scope, and never changes what anything *is*: every id, label, C4 field,
 * attachment, note text and flow stays exactly as it was.
 *
 * - **Scope**: the whole view, one boundary (with everything inside it), or a list of shapes. Nothing
 *   outside the scope moves; a boundary the scope sits in grows to hold it, never shrinks.
 * - **Where**: the arranged part keeps its old top-left corner. A partial scope that would then run
 *   into something outside it is set beside where it was instead — or, when nothing near is free,
 *   refused with the wider arrange that would make room (`suggestedOp`), never forced over a neighbour.
 * - **Connectors** touching the scope get fresh anchors. `tidy` (the default) also drops a manual
 *   routing override, since cleaning up is the point; `keep` leaves those overrides; `orthogonal`
 *   also makes them right-angled. Connectors that don't touch the scope are untouched in every mode.
 * - **Notes**: a note inside a boundary is laid out with it; a free note goes back beside the shape it
 *   sat closest to, if that shape moved.
 *
 * Bounded like a new diagram's layout: a short ladder of spacings and tie rules, the best readable
 * candidate kept (never merely the last one tried), stopping at the request's deadline.
 */

import { updateNode } from '../document/operations';
import type { DraftDocument, DraftEdge, DraftNode } from '../document/types';
import { assignAnchors, type Anchors } from '../layout/anchors';
import type { DescribeContext } from '../nodes/describe';
import type { Problems } from './errors';
import type { LayoutSpec, Reader } from './input';
import { anchorRectOf, arrangeParts, captionSizer, placeBlock, sizeToFit } from './place';
import { checkFit, checkQuality, isBetterCandidate, isCleanCandidate, renderedBoundsOf, smallestFontPresent, type FitReport, type QualityReport } from './quality';
import { drawnRoute, overlaps, pastDeadline, repairAnchors, segmentHitsBox } from './route';

type Json = Record<string, unknown>;

export interface ArrangeRequest {
  scope?: { group?: string; nodes?: string[] };
  connectors: 'tidy' | 'keep' | 'orthogonal';
  /** `false`: re-anchor connectors touching the scope without moving, resizing or re-peer-sizing any
   *  shape — a cheaper "just clean up the arrows" pass. Default `true` (the full placement pass). */
  move: boolean;
  layout: LayoutSpec;
}

const SPACINGS: LayoutSpec['spacing'][] = ['comfortable', 'spacious'];
const isNoteLike = (n: DraftNode) => n.type === 'note' || n.type === 'text' || n.type === 'code';

/** Reads `{op:"arrange", scope?, direction?, spacing?, connectors?, move?, primaryFlow?}` against the view. */
export function readArrange(r: Reader, op: Json, at: string, view: DraftDocument, base: LayoutSpec): ArrangeRequest | undefined {
  const scopeRaw = op.scope === undefined ? undefined : r.object(op.scope, `${at}/scope`);
  let scope: ArrangeRequest['scope'];
  if (scopeRaw) {
    const byId = new Map(view.nodes.map((n) => [n.id, n]));
    if (scopeRaw.group !== undefined) {
      if (typeof scopeRaw.group !== 'string' || byId.get(scopeRaw.group)?.type !== 'group') r.problems.add('INVALID_REFERENCE', `${at}/scope/group`, `no group "${String(scopeRaw.group)}" in this view`);
      else scope = { group: scopeRaw.group };
    } else if (scopeRaw.nodes !== undefined) {
      const ids = r.array(scopeRaw.nodes, `${at}/scope/nodes`, 300).filter((id): id is string => typeof id === 'string');
      const missing = ids.filter((id) => !byId.has(id));
      if (missing.length) r.problems.add('INVALID_REFERENCE', `${at}/scope/nodes`, `nothing with id ${missing.map((id) => `"${id}"`).join(', ')} in this view`);
      else if (ids.length) scope = { nodes: ids };
    }
  }
  const direction = op.direction === undefined ? undefined : r.oneOf(op.direction, `${at}/direction`, ['right', 'down'] as const);
  const spacing = op.spacing === undefined ? undefined : r.oneOf(op.spacing, `${at}/spacing`, ['compact', 'comfortable', 'spacious'] as const);
  const connectors = op.connectors === undefined ? 'tidy' : r.oneOf(op.connectors, `${at}/connectors`, ['tidy', 'keep', 'orthogonal'] as const);
  const move = r.bool(op.move, `${at}/move`) ?? true;
  const primaryFlow = typeof op.primaryFlow === 'string' ? op.primaryFlow : undefined;
  if (primaryFlow && !view.flows.some((f) => f.id === primaryFlow)) r.problems.add('INVALID_REFERENCE', `${at}/primaryFlow`, `no flow "${primaryFlow}" in this view`);
  if (!r.problems.empty || !connectors) return undefined;
  return {
    ...(scope ? { scope } : {}),
    connectors,
    move,
    layout: {
      ...base,
      direction: direction ?? readingDirectionOf(view),
      directionChosen: direction !== undefined,
      spacing: spacing ?? base.spacing,
      // An existing diagram's manual sizes are kept unless the request's own top-level layout
      // explicitly asks to normalize peers — unlike a new diagram or a newly-added block, which
      // default it on.
      normalizePeerSizes: base.normalizePeerSizes ?? false,
      ...(primaryFlow ? { primaryFlow } : {}),
    },
  };
}

/** Which way a view already reads: the way most of its connectors run. A cleanup keeps it. */
export function readingDirectionOf(view: DraftDocument): 'right' | 'down' {
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  let across = 0;
  let down = 0;
  for (const edge of view.edges) {
    const s = byId.get(edge.source);
    const t = byId.get(edge.target);
    if (!s || !t) continue;
    across += Math.abs(t.x + t.width / 2 - (s.x + s.width / 2));
    down += Math.abs(t.y + t.height / 2 - (s.y + s.height / 2));
  }
  return down > across * 1.2 ? 'down' : 'right';
}

/** Ids a scope covers: a group and everything inside it, listed shapes (a listed group with its contents), or all. */
export function scopeOf(view: DraftDocument, scope: ArrangeRequest['scope']): Set<string> {
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  const within = (node: DraftNode, roots: ReadonlySet<string>) => {
    const seen = new Set<string>();
    let at: string | undefined = node.id;
    while (at && !seen.has(at)) {
      if (roots.has(at)) return true;
      seen.add(at);
      at = byId.get(at)?.parentId;
    }
    return false;
  };
  if (!scope) return new Set(view.nodes.map((n) => n.id));
  const roots = new Set(scope.group ? [scope.group] : (scope.nodes ?? []));
  return new Set(view.nodes.filter((n) => within(n, roots)).map((n) => n.id));
}

export interface Arranged {
  view: DraftDocument;
  /** What moved or was re-anchored — what the quality check then judges. */
  touched: Set<string>;
}

/**
 * Arranges `view` as `request` asks, keeping the best readable candidate of a short ladder. Records a
 * problem (and returns `undefined`) when the scope can't be put back without overlapping its
 * surroundings.
 */
export function arrangeView(view: DraftDocument, request: ArrangeRequest, ctx: DescribeContext, problems: Problems, at: string): Arranged | undefined {
  const inScope = scopeOf(view, request.scope);
  const movable = view.nodes.filter((n) => inScope.has(n.id) && (!isNoteLike(n) || (n.parentId !== undefined && inScope.has(n.parentId))));
  if (!movable.some((n) => n.type !== 'group' && !isNoteLike(n))) return { view, touched: new Set() };

  const spacings = [request.layout.spacing, ...SPACINGS.filter((s) => s !== request.layout.spacing)];
  const attempts: LayoutSpec[] = [...spacings.map((spacing) => ({ ...request.layout, spacing })), ...spacings.map((spacing) => ({ ...request.layout, spacing, ties: 'balance' as const }))];
  let best: { arranged: Arranged; report: QualityReport; fit?: FitReport } | undefined;
  let lastRefusal = false;
  for (const layout of attempts) {
    if (best && pastDeadline()) break;
    const arranged = arrangeOnce(view, inScope, request, layout, ctx);
    if (!arranged) {
      lastRefusal = true;
      continue;
    }
    const report = checkQuality(arranged.view.nodes, arranged.view.edges, ctx, arranged.touched);
    // Measured against the whole diagram, not just the touched scope — a viewport is about how the
    // presented diagram reads overall, not only what this one edit changed.
    const fit = layout.viewport ? checkFit(renderedBoundsOf(arranged.view.nodes, arranged.view.edges, ctx), smallestFontPresent(arranged.view.nodes, arranged.view.edges), layout.viewport) : undefined;
    if (!best || isBetterCandidate({ report, fit }, { report: best.report, fit: best.fit })) best = { arranged, report, fit };
    if (isCleanCandidate({ report, fit })) break;
    // Route-only never moves a shape, so a roomier spacing changes nothing — one attempt is enough.
    if (request.move === false) break;
  }
  if (!best && lastRefusal) {
    problems.add('LAYOUT_CONSTRAINED', at, 'the arranged part would run into shapes outside the scope, and there is no free space beside it; arrange the whole view instead ({op:"arrange"})');
    return undefined;
  }
  return best?.arranged;
}

function arrangeOnce(view: DraftDocument, inScope: ReadonlySet<string>, request: ArrangeRequest, layout: LayoutSpec, ctx: DescribeContext): Arranged | undefined {
  if (request.move === false) return routeOnly(view, inScope, request, ctx);
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  const elements = new Map<string, DraftNode>();
  const groups = new Map<string, DraftNode>();
  const memberNotes = new Map<string, DraftNode>();
  const besideNotes = new Map<string, DraftNode[]>();
  for (const node of view.nodes) {
    if (!inScope.has(node.id)) continue;
    if (node.type === 'group') groups.set(node.id, { ...node });
    else if (!isNoteLike(node)) elements.set(node.id, grown(node, ctx));
  }
  // A note inside a boundary is either about the boundary (its heading) or about the shape it sits
  // beside there — which one isn't stored, so it is read off where the note is: beside a shape of the
  // same boundary, it stays with that shape; otherwise it heads the boundary.
  for (const node of view.nodes) {
    if (!inScope.has(node.id) || !isNoteLike(node) || !node.parentId || !inScope.has(node.parentId)) continue;
    const host = nearestShape(node, view.nodes, BESIDE_REACH);
    if (host && host.parentId === node.parentId && elements.has(host.id)) besideNotes.set(host.id, [...(besideNotes.get(host.id) ?? []), { ...node }]);
    else memberNotes.set(node.id, { ...node });
  }
  // (A shape whose boundary is outside the scope is laid out as if loose — `arrangeParts` only nests
  // within the groups it is given — and stays that boundary's member.)
  const inner = view.edges.filter((e) => elements.has(e.source) && elements.has(e.target)).map((e) => restyled(e, request.connectors));
  const primary = view.flows.find((f) => f.id === layout.primaryFlow);
  arrangeParts({ elements, groups, memberNotes, besideNotes, edges: inner, primaryEdges: new Set(primary?.steps.flatMap((s) => (s.edgeId ? [s.edgeId] : [])) ?? []) }, layout, ctx);

  // Back where the scope was: its old top-left corner, or beside it when that would collide.
  const besides = [...besideNotes.values()].flat();
  const moved = [...elements.values(), ...groups.values(), ...memberNotes.values(), ...besides];
  const before = view.nodes.filter((n) => elements.has(n.id) || groups.has(n.id) || memberNotes.has(n.id) || besides.some((b) => b.id === n.id));
  const oldBox = boxOf(before);
  const newBox = boxOf(moved);
  // Free notes follow the shape they sit beside, so they aren't in the way either.
  const followers = new Set(view.nodes.filter((n) => isNoteLike(n) && !n.parentId && inScope.has(nearestShape(n, view.nodes)?.id ?? '')).map((n) => n.id));
  const outside = view.nodes.filter((n) => !inScope.has(n.id) && !followers.has(n.id) && !containsScope(n, before, byId));
  let origin = { x: oldBox.x, y: oldBox.y };
  const collides = (o: { x: number; y: number }) =>
    outside.some((n) => o.x - 24 < n.x + n.width && n.x < o.x + newBox.width + 24 && o.y - 24 < n.y + n.height && n.y < o.y + newBox.height + 24);
  if (outside.length && collides(origin)) {
    const pseudo: DraftNode = { id: '__scope', type: 'service', x: oldBox.x, y: oldBox.y, width: oldBox.width, height: oldBox.height, z: 0 };
    const rest: DraftDocument = { ...view, nodes: outside };
    const found = placeBlock(rest, pseudo, { width: newBox.width, height: newBox.height }, layout.direction, undefined, 48);
    if (!found) return undefined;
    origin = found;
  }
  const dx = origin.x - newBox.x;
  const dy = origin.y - newBox.y;
  const placed = new Map(moved.map((n) => [n.id, { ...n, x: Math.round(n.x + dx), y: Math.round(n.y + dy) }]));
  let next: DraftDocument = { ...view, nodes: view.nodes.map((n) => placed.get(n.id) ?? n) };

  // Connectors: the inner ones as arranged; those crossing the scope's edge re-anchored from where
  // both ends now are; every other one untouched.
  const innerById = new Map(inner.map((e) => [e.id, e]));
  const crossing = view.edges.filter((e) => !innerById.has(e.id) && (elements.has(e.source) || elements.has(e.target))).map((e) => restyled(e, request.connectors));
  const rects = new Map(next.nodes.map((n) => [n.id, anchorRectOf(n)]));
  const anchors = assignAnchors(crossing, rects, layout.direction);
  for (const e of crossing) Object.assign(e, anchors.get(e.id) ?? {});
  const changed = new Map([...inner, ...crossing].map((e) => [e.id, e]));
  next = { ...next, edges: next.edges.map((e) => changed.get(e.id) ?? e) };
  const touchedEdges = next.edges.filter((e) => changed.has(e.id));
  repairAnchors(touchedEdges, next.nodes, captionSizer(next.nodes, ctx), next.edges);

  // Free notes back beside the shape they sat closest to, when that shape moved: first tried at the
  // same offset from the host it already had (a person's own placement kept, not just "some clear
  // spot"), and only replaced with a fresh `placeBeside` when that offset is no longer free.
  const touched = new Set<string>([...placed.keys(), ...changed.keys()]);
  for (const note of view.nodes) {
    if (!isNoteLike(note) || placed.has(note.id) || (note.parentId && byId.get(note.parentId)?.type === 'group')) continue;
    const host = nearestShape(note, view.nodes);
    if (!host || !placed.has(host.id)) continue;
    const movedHost = next.nodes.find((n) => n.id === host.id)!;
    const dx = movedHost.x - host.x;
    const dy = movedHost.y - host.y;
    const beside = translatedBeside(next, note.id, dx, dy) ?? placeBeside(next, note.id, movedHost, layout.direction);
    if (beside) {
      next = beside;
      touched.add(note.id);
    }
  }
  // Boundaries the scope sits in grow to hold it.
  for (const node of moved) if (node.parentId && !inScope.has(node.parentId)) next = fitGroups(next, node.id);
  return { view: next, touched };
}

/**
 * `move: false`: re-anchors every connector touching the scope, moving, resizing or re-peer-sizing
 * nothing. An edge that shares a node with one being re-anchored, but doesn't itself touch the
 * scope, is passed to `assignAnchors` as `pinned` — fixed at its current anchor — so the scoped
 * edges route clear of it instead of colliding with a neighbour this request has no business
 * moving. An edge with no persisted anchor of its own (never arranged, only ever hand-drawn) can't
 * be pinned to a specific slot and is left out of that occupancy check — a narrower case than the
 * common one, where every edge that has been through `create_diagram` or an earlier `arrange`
 * already carries the anchors this relies on.
 */
function routeOnly(view: DraftDocument, inScope: ReadonlySet<string>, request: ArrangeRequest, ctx: DescribeContext): Arranged {
  const touching = view.edges.filter((e) => inScope.has(e.source) || inScope.has(e.target));
  const touched = touching.map((e) => restyled(e, request.connectors));
  const touchedIds = new Set(touched.map((e) => e.id));
  const affectedNodes = new Set(touched.flatMap((e) => [e.source, e.target]));
  const neighbours = view.edges.filter((e) => !touchedIds.has(e.id) && (affectedNodes.has(e.source) || affectedNodes.has(e.target)) && e.sourceAnchor && e.targetAnchor);
  const rects = new Map(view.nodes.map((n) => [n.id, anchorRectOf(n)]));
  const pinned = new Map<string, Anchors>(neighbours.map((e) => [e.id, { sourceAnchor: e.sourceAnchor as NonNullable<DraftEdge['sourceAnchor']>, targetAnchor: e.targetAnchor as NonNullable<DraftEdge['targetAnchor']> }]));
  const anchors = assignAnchors([...touched, ...neighbours], rects, request.layout.direction, pinned);
  for (const e of touched) Object.assign(e, anchors.get(e.id) ?? {});
  const changed = new Map(touched.map((e) => [e.id, e]));
  const next: DraftDocument = { ...view, edges: view.edges.map((e) => changed.get(e.id) ?? e) };
  repairAnchors(touched, next.nodes, captionSizer(next.nodes, ctx), next.edges);
  return { view: next, touched: new Set(changed.keys()) };
}

/** A shape at least as big as it was, and big enough for its text. */
function grown(node: DraftNode, ctx: DescribeContext): DraftNode {
  try {
    const sized = sizeToFit(node, ctx);
    return { ...node, width: Math.max(node.width, sized.width), height: Math.max(node.height, sized.height) };
  } catch {
    return { ...node };
  }
}

function restyled(edge: DraftEdge, connectors: ArrangeRequest['connectors']): DraftEdge {
  const next: DraftEdge = { ...edge };
  if (connectors !== 'keep') delete next.routeMode;
  if (connectors === 'orthogonal') next.routing = 'smoothstep';
  return next;
}

function boxOf(nodes: readonly DraftNode[]) {
  const x = Math.min(...nodes.map((n) => n.x));
  const y = Math.min(...nodes.map((n) => n.y));
  return { x, y, width: Math.max(...nodes.map((n) => n.x + n.width)) - x, height: Math.max(...nodes.map((n) => n.y + n.height)) - y };
}

/** A boundary that holds part of the scope isn't "outside" it: it grows instead. */
function containsScope(node: DraftNode, scope: readonly DraftNode[], byId: Map<string, DraftNode>): boolean {
  if (node.type !== 'group') return false;
  return scope.some((s) => {
    const seen = new Set<string>();
    let at = s.parentId;
    while (at && !seen.has(at)) {
      if (at === node.id) return true;
      seen.add(at);
      at = byId.get(at)?.parentId;
    }
    return false;
  });
}

/** How close a note inside a boundary must sit to a shape to count as that shape's rather than the
 *  boundary's own: a note laid out beside its shape sits `NOTE_GAP` (20) from it. */
const BESIDE_REACH = 48;

/** The shape a note sits closest to (edge to edge), within a short reach. */
export function nearestShape(note: DraftNode, nodes: readonly DraftNode[], reach = 160): DraftNode | undefined {
  let best: { node: DraftNode; gap: number } | undefined;
  for (const n of nodes) {
    if (n.id === note.id || n.type === 'group' || isNoteLike(n)) continue;
    const dx = Math.max(0, n.x - (note.x + note.width), note.x - (n.x + n.width));
    const dy = Math.max(0, n.y - (note.y + note.height), note.y - (n.y + n.height));
    const gap = Math.hypot(dx, dy);
    if (gap <= reach && (!best || gap < best.gap)) best = { node: n, gap };
  }
  return best?.node;
}

/** Grows every boundary above `id` (never shrinking one) so it holds its contents with its padding. */
export function fitGroups(view: DraftDocument, id: string): DraftDocument {
  let doc = view;
  let current = doc.nodes.find((n) => n.id === id)?.parentId;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const group = doc.nodes.find((n) => n.id === current);
    if (!group) break;
    const inside = doc.nodes.filter((n) => n.parentId === group.id);
    if (inside.length) {
      const pad = 36;
      const header = group.boundaryPreset === 'boundary' ? 44 : 56;
      const minX = Math.min(group.x, ...inside.map((n) => n.x - pad));
      const minY = Math.min(group.y, ...inside.map((n) => n.y - header));
      const maxX = Math.max(group.x + group.width, ...inside.map((n) => n.x + n.width + pad));
      const maxY = Math.max(group.y + group.height, ...inside.map((n) => n.y + n.height + pad));
      doc = updateNode(doc, group.id, { x: minX, y: minY, width: maxX - minX, height: maxY - minY });
    }
    current = group.parentId;
  }
  return doc;
}

/**
 * Moves a free note by the same delta its host just moved by, keeping whatever offset and side a
 * person gave it — clear of every other shape and of connectors as drawn, exactly like `placeBeside`
 * checks, just at this one specific spot rather than searching for a fresh one. `undefined` when the
 * translated spot collides with something, so the caller can fall back to `placeBeside`.
 */
function translatedBeside(view: DraftDocument, noteId: string, dx: number, dy: number): DraftDocument | undefined {
  const note = view.nodes.find((n) => n.id === noteId);
  if (!note) return undefined;
  const box = { x: Math.round(note.x + dx), y: Math.round(note.y + dy), width: note.width, height: note.height };
  const others = view.nodes.filter((n) => n.id !== noteId);
  if (others.some((n) => overlaps(box, n))) return undefined;
  const lines = view.edges.flatMap((edge) => {
    const drawn = drawnRoute(edge, others, view.edges);
    return drawn ? [drawn.points] : [];
  });
  if (lines.some((line) => line.some((point, k) => k > 0 && segmentHitsBox(line[k - 1]!, point, box)))) return undefined;
  return updateNode(view, noteId, { x: box.x, y: box.y });
}

/**
 * Moves a free note beside `host`, clear of every other shape and of connectors as drawn; nothing
 * else moves. `undefined` when there is no such spot near it.
 */
export function placeBeside(view: DraftDocument, noteId: string, host: DraftNode, direction: LayoutSpec['direction']): DraftDocument | undefined {
  const note = view.nodes.find((n) => n.id === noteId);
  if (!note) return undefined;
  const others = { ...view, nodes: view.nodes.filter((n) => n.id !== noteId) };
  const lines = view.edges.flatMap((edge) => {
    const drawn = drawnRoute(edge, others.nodes, view.edges);
    return drawn ? [drawn.points] : [];
  });
  const at = placeBlock(others, host, { width: note.width, height: note.height }, direction, undefined, 32, false, lines.length ? lines : [[]]);
  return at ? updateNode(view, noteId, { x: at.x, y: at.y, parentId: undefined }) : undefined;
}

const NOTE_GAP = 24;

/** Puts a free note inside a boundary, under what it already holds, and grows the boundary to fit. */
export function placeInGroup(view: DraftDocument, noteId: string, groupId: string): DraftDocument {
  const group = view.nodes.find((n) => n.id === groupId);
  if (!group) return view;
  const members = view.nodes.filter((n) => n.parentId === groupId && n.id !== noteId);
  const pad = 36;
  const header = group.boundaryPreset === 'boundary' ? 44 : 56;
  const x = members.length ? Math.min(...members.map((m) => m.x)) : group.x + pad;
  const y = members.length ? Math.max(...members.map((m) => m.y + m.height)) + NOTE_GAP : group.y + header;
  return fitGroups(updateNode(view, noteId, { x: Math.round(x), y: Math.round(y), parentId: groupId }), noteId);
}
