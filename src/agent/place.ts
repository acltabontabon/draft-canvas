/**
 * From a checked request to real, positioned document elements: native nodes (sized by the renderer's
 * own measurement), native connectors (semantics from the capability matrix, exactly as a hand-drawn
 * one gets them), boundaries sized around what they hold, anchors chosen from the final geometry, and
 * flows over those connectors. Nothing here is special to agents — the output is indistinguishable
 * from a diagram someone drew and arranged by hand.
 */

import { capabilityFor, categoryOf, inferRelationship } from '../document/connectorSemantics';
import { relationshipCaptionLabel } from '../document/edgeSemantics';
import { createAttachment, createDocument, createEdge, createNode } from '../document/factory';
import { createFlow } from '../document/flow';
import type { Attachment, DraftDocument, DraftEdge, DraftFlow, DraftFlowStep, DraftNode, DraftNodeType, ViewLevel } from '../document/types';
import { hasAttachmentRoom } from '../document/operations';
import { anchorBandOf } from '../document/queueGeometry';
import { roomOf } from '../depth/tree';
import { layoutGraph, LayoutError, type Direction, type LayoutEdge } from '../layout/layered';
import { assignAnchors, type AnchorRect } from '../layout/anchors';
import { describeContext, naturalArchitectureSize, naturalNoteHeight, type DescribeContext } from '../nodes/describe';
import { FONTS, LINE_HEIGHTS } from '../render/text/fonts';
import { layoutText } from '../render/text/layout';
import { getMeasurer } from '../render/text/measure';
import { LIGHT } from '../render/theme/tokens';
import { BAND, BOUNDARY_HEADER, BOUNDARY_HEADER_TITLE_ONLY, BOUNDARY_PAD, GUTTER } from '../starters/compose';
import { AgentError } from './errors';
import type { AttachmentSpec, LayoutSpec, NodeSpec, NoteSpec, RelationshipSpec, RoomSpec } from './input';
import { drawnRoute, repairAnchors, segmentHitsBox } from './route';
import { GROUP_KINDS } from './vocabulary';

const SPACING_FACTOR = { compact: 0.8, comfortable: 1, spacious: 1.3 } as const;
/** How wide a connector's caption may grow before it wraps — the canvas's own chip limit. */
const EDGE_LABEL_MAX = 220;

export interface PlacedRoom {
  nodes: DraftNode[];
  edges: DraftEdge[];
  flows: DraftFlow[];
  level?: Exclude<ViewLevel, 'none'>;
  /** Non-blocking remarks for the receipt (a semantic the matrix doesn't offer, and so on). */
  advisories: string[];
}

export function measureContext(): DescribeContext {
  // Colour never changes where text goes; the light theme is as good as any for measuring.
  return { ...describeContext(LIGHT), measurer: getMeasurer() };
}

export function spacingOf(layout: Pick<LayoutSpec, 'spacing'>) {
  const f = SPACING_FACTOR[layout.spacing];
  return {
    layer: Math.round(BAND * f),
    sibling: Math.round(GUTTER * 0.75 * f),
    pad: BOUNDARY_PAD,
    component: Math.round(GUTTER * 1.5 * f),
  };
}

export function attachmentsOf(specs: AttachmentSpec[] | undefined) {
  return (specs ?? []).map((a) =>
    createAttachment(
      a.kind === 'code'
        ? { type: 'code', code: a.code ?? '', language: a.language ?? 'plaintext' }
        : { type: 'note', text: a.text ?? '', noteKind: a.noteKind ?? 'note' },
    ),
  );
}

/** A native element for a spec, at its natural size (grown, never shrunk, from the type's default). */
export function elementFor(spec: NodeSpec, ctx: DescribeContext, parentId?: string): DraftNode {
  const node = createNode({
    id: spec.id,
    type: spec.shape.type,
    x: 0,
    y: 0,
    text: spec.label,
    ...(spec.shape.serviceKind ? { serviceKind: spec.shape.serviceKind } : {}),
    ...(spec.shape.databaseKind ? { databaseKind: spec.shape.databaseKind } : {}),
    ...(spec.shape.queueKind ? { queueKind: spec.shape.queueKind } : {}),
    ...(spec.shape.actorKind ? { actorKind: spec.shape.actorKind } : {}),
    ...(spec.shape.componentKind ? { componentKind: spec.shape.componentKind } : {}),
    ...(spec.shape.deliveryRole ? { deliveryRole: spec.shape.deliveryRole } : {}),
    ...(spec.description ? { description: spec.description } : {}),
    ...(spec.technology ? { technology: spec.technology } : {}),
    ...(spec.color ? { accent: spec.color } : {}),
    ...(parentId ? { parentId } : {}),
  });
  const attachments = attachmentsOf(spec.attachments);
  if (attachments.length) node.attachments = attachments;
  return sizeToFit(node, ctx);
}

/** Which field tells two shapes of the same type apart for peer sizing — an API service and a
 *  message queue are both `service`s but read as different rows if grouped together. */
const PEER_SUBKIND_FIELD: Partial<Record<DraftNodeType, keyof DraftNode>> = {
  service: 'serviceKind',
  database: 'databaseKind',
  queue: 'queueKind',
  actor: 'actorKind',
  component: 'componentKind',
};

/** How much larger than its group's typical size a shape may be before it is left as its own case
 *  instead of being folded into (or stretching) the shared size — one long description must not
 *  balloon every sibling that happens to share its type. */
const PEER_OUTLIER_FACTOR = 1.5;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * How far each id sits from a source along `edges`, by longest path — the same idea
 * `layout/layered.ts`'s own rank assignment uses, independently and much more loosely: this is only
 * ever a grouping signal (are two shapes actually side by side, or is one downstream of the other?),
 * never a layout decision, so it skips that module's careful, deterministic cycle-breaking. A cycle
 * here just stops contributing extra depth past the point it's re-entered — fine for "roughly which
 * layer," not fine for laying anything out.
 */
function rankOf(ids: Iterable<string>, edges: readonly { source: string; target: string }[]): Map<string, number> {
  const known = new Set(ids);
  const preds = new Map<string, string[]>();
  for (const id of known) preds.set(id, []);
  for (const e of edges) {
    if (!known.has(e.source) || !known.has(e.target) || e.source === e.target) continue;
    preds.get(e.target)?.push(e.source);
  }
  const rank = new Map<string, number>();
  const visiting = new Set<string>();
  const rankOfId = (id: string): number => {
    const cached = rank.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const p = preds.get(id) ?? [];
    const r = p.length ? Math.max(...p.map((pid) => rankOfId(pid) + 1)) : 0;
    visiting.delete(id);
    rank.set(id, r);
    return r;
  };
  for (const id of known) rankOfId(id);
  return rank;
}

/**
 * Gives peer shapes — same type, same sub-kind, same parent, and (by `rankOf`) roughly the same
 * distance along the graph — one shared size, so a row of actors or external systems reads as a row
 * instead of whatever each one's own content happened to need. The rank check is what keeps a merge
 * point or a hub out of a group of the parallel shapes that feed it: same type and sub-kind isn't
 * enough on its own to make two shapes read as peers when one is structurally downstream of, or
 * central to, the other. Runs after every element already has its own content-fitting size
 * (`sizeToFit`/`grown`), so this only ever grows a box: shrinking one would clip text that already
 * fit. A member far larger than its group's typical size (`PEER_OUTLIER_FACTOR`) is left at its own
 * size and excluded from the shared one, so it can never grow its peers to match it.
 */
export function peerNormalize(elements: Map<string, DraftNode>, edges: readonly DraftEdge[], ctx: DescribeContext): void {
  const rank = rankOf(elements.keys(), edges);
  const groups = new Map<string, DraftNode[]>();
  for (const node of elements.values()) {
    const field = PEER_SUBKIND_FIELD[node.type];
    if (!field) continue;
    const key = `${node.type}\u0000${String(node[field] ?? '')}\u0000${node.parentId ?? ''}\u0000${rank.get(node.id) ?? 0}`;
    const list = groups.get(key) ?? [];
    list.push(node);
    groups.set(key, list);
  }
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const medianWidth = median(members.map((n) => n.width));
    const medianHeight = median(members.map((n) => n.height));
    const core = members.filter((n) => n.width <= medianWidth * PEER_OUTLIER_FACTOR && n.height <= medianHeight * PEER_OUTLIER_FACTOR);
    if (core.length < 2) continue;
    const sharedWidth = Math.max(...core.map((n) => n.width));
    const sharedHeight = Math.max(...core.map((n) => n.height));
    for (const node of core) {
      const width = Math.max(node.width, sharedWidth);
      const height = Math.max(node.height, sharedHeight);
      if (width === node.width && height === node.height) continue;
      // Growing can only help text fit, but verified rather than assumed: a member that somehow
      // still wouldn't fit at the shared size is left at its own size instead of clipping.
      const check = naturalArchitectureSize({ ...node, width, height }, ctx, { maxWidth: width, maxHeight: height });
      if (!check.fits) continue;
      node.width = width;
      node.height = height;
    }
  }
}

export function sizeToFit(node: DraftNode, ctx: DescribeContext): DraftNode {
  if (node.type === 'ellipse' || node.type === 'group' || node.type === 'text' || node.type === 'code') return node;
  if (node.type === 'note') {
    const height = Math.max(node.height, naturalNoteHeight(node, node.text ?? '', { measurer: ctx.measurer }));
    return { ...node, height };
  }
  const natural = naturalArchitectureSize(node, ctx);
  if (!natural.fits) {
    throw new AgentError('LIMIT_EXCEEDED', `"${node.text}" is too long to show in full on one shape.`, {
      hint: 'Shorten the label or description; keep long explanations in a note.',
      details: { id: node.id },
    });
  }
  return { ...node, width: natural.width, height: natural.height };
}

/** A native connector for a spec: the matrix's semantics unless the request named ones it offers. */
export function connectorFor(spec: RelationshipSpec, source: DraftNode, target: DraftNode, advisories: string[]): DraftEdge {
  const offered = capabilityFor(categoryOf(source), categoryOf(target));
  const inferred = inferRelationship(source, target);
  let semantic = inferred?.semantic;
  let origin: DraftEdge['semanticsOrigin'] = inferred?.semantic ? 'inferred' : undefined;
  if (spec.semantic) {
    if (offered?.relations.includes(spec.semantic)) {
      semantic = spec.semantic;
      origin = 'explicit';
    } else {
      advisories.push(
        `${spec.id}: "${spec.semantic}" isn't a relationship Draft Canvas offers from ${categoryOf(source)} to ${categoryOf(target)}${semantic ? `; used "${semantic}"` : ''}.`,
      );
    }
  }
  let kind = inferred?.kind;
  if (spec.kind) {
    if (!offered || offered.behaviors.length === 0 || offered.behaviors.includes(spec.kind)) {
      kind = spec.kind;
      origin = 'explicit';
    } else {
      advisories.push(`${spec.id}: behaviour "${spec.kind}" isn't offered for this pairing; kept "${kind ?? 'none'}".`);
    }
  }
  if (offered?.status && offered.status !== 'valid' && offered.guidance) {
    advisories.push(`${spec.id}: ${offered.guidance}`);
  }
  const edge = createEdge({
    id: spec.id,
    source: source.id,
    target: target.id,
    ...(spec.label ? { label: spec.label } : {}),
    ...(spec.condition ? { condition: spec.condition } : {}),
    ...(spec.directed === false ? { directed: false } : {}),
    ...(semantic ? { semantic } : {}),
    ...(kind ? { kind } : {}),
    ...(spec.async ?? inferred?.async ? { async: true } : {}),
    ...(origin ? { semanticsOrigin: origin } : {}),
  });
  const attachments = attachmentsOf(spec.attachments);
  if (attachments.length) edge.attachments = attachments;
  return edge;
}

/** The size a connector's words take on the canvas — its own label, or the relationship caption. */
export function edgeLabelSize(edge: DraftEdge, source: DraftNode, target: DraftNode, ctx: DescribeContext): { width: number; height: number } {
  const text = edge.label ?? (edge.semantic ? relationshipCaptionLabel(edge.semantic, { source: categoryOf(source), target: categoryOf(target) }) : '');
  if (!text) return { width: 0, height: 0 };
  const layout = layoutText(text, {
    font: FONTS.edgeLabel,
    maxWidth: EDGE_LABEL_MAX,
    lineHeight: FONTS.edgeLabel.size * LINE_HEIGHTS.label,
    measurer: ctx.measurer,
  });
  return { width: Math.ceil(layout.width) + 12, height: Math.ceil(layout.height) + 6 };
}

/** Where a connector meets a shape along one side: the side's axis coordinate (y for left/right). */
function anchorCoordinate(node: DraftNode, side: 'left' | 'right' | 'top' | 'bottom', offset: number): number {
  if (side === 'left' || side === 'right') {
    const band = anchorBandOf(node);
    const top = band?.top ?? node.y;
    const bottom = band?.bottom ?? node.y + node.height;
    return top + offset * (bottom - top);
  }
  return node.x + offset * node.width;
}

/** Past this, two ends are meant to be at different heights; under it, the difference is a jog. A
 *  balanced arrangement (the repair fallback) snaps only the last few pixels, as it always did. */
const JOG = { align: 72, balance: 10 } as const;

/**
 * The last straightening, after anchors are known: a connector whose two ends are nearly level (or
 * plumb) steps sideways on its way, and the router hangs its caption on the step — across the line.
 * The target (or else the source) moves by the difference when that collides with nothing, keeps it
 * inside its boundary, and leaves more of that shape's connectors straight than before (a shape can
 * line up with only so many neighbours; moving it for one must not skew two others).
 */
function snapLevelJogs(edges: DraftEdge[], elements: Map<string, DraftNode>, groups: Map<string, DraftNode>, limit: number): void {
  const all = () => [...elements.values()];
  const free = (node: DraftNode, dx: number, dy: number) => {
    const box = { x: node.x + dx, y: node.y + dy, width: node.width, height: node.height };
    const clear = all().every(
      (other) =>
        other.id === node.id ||
        box.x + box.width + 12 <= other.x ||
        other.x + other.width + 12 <= box.x ||
        box.y + box.height + 12 <= other.y ||
        other.y + other.height + 12 <= box.y,
    );
    const parent = node.parentId ? groups.get(node.parentId) : undefined;
    const inside = !parent || (box.x >= parent.x && box.y >= parent.y + 36 && box.x + box.width <= parent.x + parent.width && box.y + box.height <= parent.y + parent.height);
    return clear && inside;
  };
  /** How far `edge`'s ends are out of line, or undefined when its sides don't face along one axis. */
  const skew = (edge: DraftEdge): { delta: number; horizontal: boolean } | undefined => {
    const s = edge.sourceAnchor;
    const t = edge.targetAnchor;
    const source = elements.get(edge.source);
    const target = elements.get(edge.target);
    if (!s || !t || !source || !target) return undefined;
    const horizontal = (s.side === 'left' || s.side === 'right') && (t.side === 'left' || t.side === 'right');
    const vertical = (s.side === 'top' || s.side === 'bottom') && (t.side === 'top' || t.side === 'bottom');
    if (!horizontal && !vertical) return undefined;
    return { delta: anchorCoordinate(source, s.side, s.offset) - anchorCoordinate(target, t.side, t.offset), horizontal };
  };
  const straightAt = (id: string) => edges.filter((e) => (e.source === id || e.target === id) && skew(e)?.delta === 0).length;
  const tryMove = (node: DraftNode, dx: number, dy: number) => {
    if (!free(node, dx, dy)) return false;
    const before = straightAt(node.id);
    node.x += dx;
    node.y += dy;
    if (straightAt(node.id) > before) return true;
    node.x -= dx;
    node.y -= dy;
    return false;
  };
  for (let pass = 0; pass < 2; pass += 1) {
    for (const edge of edges) {
      const off = skew(edge);
      if (!off || off.delta === 0 || Math.abs(off.delta) > limit) continue;
      const [dx, dy] = off.horizontal ? [0, off.delta] : [off.delta, 0];
      const source = elements.get(edge.source) as DraftNode;
      const target = elements.get(edge.target) as DraftNode;
      if (!tryMove(target, dx, dy)) tryMove(source, -dx, -dy);
    }
  }
}

/** A node as anchor assignment sees it: its box, plus the band a queue's or Data Store's connectors use. */
/** Where a connector meets `node` squarely: the middle of its tube or glyph, else of its box. */
export function lineOf(node: DraftNode): { x: number; y: number } {
  const band = anchorBandOf(node);
  return {
    x: band?.left !== undefined && band.right !== undefined ? (band.left + band.right) / 2 : node.x + node.width / 2,
    y: band ? (band.top + band.bottom) / 2 : node.y + node.height / 2,
  };
}

export function anchorRectOf(node: DraftNode): AnchorRect {
  const band = anchorBandOf(node);
  return { x: node.x, y: node.y, width: node.width, height: node.height, ...(band ? { bandTop: band.top, bandBottom: band.bottom } : {}) };
}

/** Caption sizes for connectors among `nodes`, for the route check (`route.ts`). */
export function captionSizer(nodes: readonly DraftNode[], ctx: DescribeContext) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return (edge: DraftEdge) => {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    return source && target ? edgeLabelSize(edge, source, target, ctx) : { width: 0, height: 0 };
  };
}

function titleWidth(text: string, ctx: DescribeContext): number {
  return ctx.measurer.width(text, FONTS.groupTitle) + 12 * 2 + 16;
}

/** What `arrangeParts` arranges: native shapes, sized, whose positions (and connector anchors) it sets. */
export interface RoomParts {
  elements: Map<string, DraftNode>;
  groups: Map<string, DraftNode>;
  /** Free notes laid out as members of their boundary. */
  memberNotes: Map<string, DraftNode>;
  edges: DraftEdge[];
  /** The relationships of the flow to lay out as the main path, if one was named. */
  primaryEdges: ReadonlySet<string>;
}

/** Room between a shape and its loop companion: two arrowheads, and the pair's captions beside them. */
const COMPANION_GAP = 72;

/**
 * Loop companions, by host: a shape joined to exactly one other, by connectors both ways — a retry
 * queue and the worker it hands messages back to. Given a layer of its own, the way back becomes a
 * detour around the diagram; kept beside its host, across the flow, the loop is a short pair of
 * parallel connectors. Only within one boundary, never a host that is itself someone's companion,
 * and never a pair that is all there is (two shapes and nothing else read fine as they are).
 */
function companionsOf(elements: Map<string, DraftNode>, edges: readonly DraftEdge[]): Map<string, string> {
  const neighbours = new Map<string, Set<string>>();
  const directed = new Set<string>();
  for (const edge of edges) {
    if (!elements.has(edge.source) || !elements.has(edge.target) || edge.source === edge.target) continue;
    for (const [a, b] of [[edge.source, edge.target], [edge.target, edge.source]] as const) {
      const set = neighbours.get(a) ?? new Set<string>();
      set.add(b);
      neighbours.set(a, set);
    }
    directed.add(`${edge.source}\u0000${edge.target}`);
  }
  const hostOf = new Map<string, string>();
  for (const [id, set] of neighbours) {
    if (set.size !== 1) continue;
    const host = [...set][0] as string;
    if ((neighbours.get(host)?.size ?? 0) < 2) continue;
    if (!directed.has(`${id}\u0000${host}`) || !directed.has(`${host}\u0000${id}`)) continue;
    if (elements.get(id)?.parentId !== elements.get(host)?.parentId) continue;
    hostOf.set(id, host);
  }
  const byHost = new Map<string, string>();
  for (const [id, host] of [...hostOf].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (hostOf.has(host) || byHost.has(host)) continue;
    byHost.set(host, id);
  }
  return byHost;
}

/**
 * The deterministic arrangement shared by a new diagram and an `arrange` of an existing one: the
 * layered layout (boundaries sized around what they hold, captions given room), anchors chosen from
 * the final geometry, then the last straightening of nearly-level connectors. Mutates the parts in
 * place — they are the caller's fresh copies — and returns the size of what it arranged, from (0, 0).
 */
export function arrangeParts(parts: RoomParts, layout: LayoutSpec, ctx: DescribeContext): { width: number; height: number } {
  const { elements, groups, memberNotes, edges, primaryEdges } = parts;
  if (layout.normalizePeerSizes) peerNormalize(elements, edges, ctx);
  const right = layout.direction === 'right';
  // A loop companion rides with its host as one box (see `companionsOf`): the host first, the
  // companion beyond it across the flow, and the host's own line what the layout aligns on.
  const companionOf = companionsOf(elements, edges);
  const companions = new Set(companionOf.values());
  // The pair's two connectors leave one and reach the other at the same fractions of a side, so
  // they run straight only if that side is as long on both: the shorter one grows to match.
  for (const [hostId, mateId] of companionOf) {
    const host = elements.get(hostId)!;
    const mate = elements.get(mateId)!;
    if (right) {
      host.width = mate.width = Math.max(host.width, mate.width);
    } else if (!anchorBandOf({ ...host, x: 0, y: 0 }) && !anchorBandOf({ ...mate, x: 0, y: 0 })) {
      host.height = mate.height = Math.max(host.height, mate.height);
    }
  }
  const lineAcross = (n: DraftNode) => {
    const band = anchorBandOf({ ...n, x: 0, y: 0 });
    return right ? (band ? (band.top + band.bottom) / 2 : n.height / 2) : n.width / 2;
  };
  const layoutEdges: LayoutEdge[] = edges
    .filter((edge) => !companions.has(edge.source) && !companions.has(edge.target))
    .map((edge) => {
      const size = edgeLabelSize(edge, elements.get(edge.source)!, elements.get(edge.target)!, ctx);
      const target = elements.get(edge.target);
      const minor = edge.kind === 'failure' || edge.kind === 'retry' || edge.semantic === 'deadLetters' || target?.deliveryRole === 'dead-letter';
      return { id: edge.id, source: edge.source, target: edge.target, labelWidth: size.width, labelHeight: size.height, primary: primaryEdges.has(edge.id), minor };
    });
  let placed;
  try {
    placed = layoutGraph({
      boxes: [...elements.values(), ...memberNotes.values()]
        .filter((n) => !companions.has(n.id))
        .map((n) => {
          const band = anchorBandOf({ ...n, x: 0, y: 0 });
          const parent = n.parentId && groups.has(n.parentId) ? { parent: n.parentId } : {};
          const mate = elements.get(companionOf.get(n.id) ?? '');
          if (mate) {
            return right
              ? { id: n.id, width: Math.max(n.width, mate.width), height: n.height + COMPANION_GAP + mate.height, lead: lineAcross(n), ...parent }
              : { id: n.id, width: n.width + COMPANION_GAP + mate.width, height: Math.max(n.height, mate.height), lead: lineAcross(n), ...parent };
          }
          return { id: n.id, width: n.width, height: n.height, ...parent, ...(band ? { band: (band.top + band.bottom) / 2 } : {}) };
        }),
      groups: [...groups.values()].map((g) => ({
        id: g.id,
        ...(g.parentId && groups.has(g.parentId) ? { parent: g.parentId } : {}),
        header: g.boundaryPreset === 'boundary' ? BOUNDARY_HEADER_TITLE_ONLY : BOUNDARY_HEADER,
        minWidth: titleWidth(g.text ?? '', ctx),
      })),
      edges: layoutEdges,
      direction: layout.direction as Direction,
      spacing: spacingOf(layout),
      ...(layout.ties ? { ties: layout.ties } : {}),
    });
  } catch (error) {
    if (error instanceof LayoutError) throw new AgentError('LAYOUT_FAILED', error.message);
    throw error;
  }

  const rects = new Map<string, AnchorRect>();
  for (const [id, node] of elements) {
    if (companions.has(id)) continue;
    const at = placed.boxes.get(id)!;
    const mate = elements.get(companionOf.get(id) ?? '');
    node.x = at.x;
    node.y = at.y;
    if (mate) {
      // Centred on each other across the pair, so the two connectors between them run straight.
      if (right) {
        const width = Math.max(node.width, mate.width);
        node.x = at.x + (width - node.width) / 2;
        mate.x = at.x + (width - mate.width) / 2;
        mate.y = at.y + node.height + COMPANION_GAP;
      } else {
        const height = Math.max(node.height, mate.height);
        node.y = at.y + (height - node.height) / 2;
        mate.y = at.y + (height - mate.height) / 2;
        mate.x = at.x + node.width + COMPANION_GAP;
      }
      node.x = Math.round(node.x);
      node.y = Math.round(node.y);
      mate.x = Math.round(mate.x);
      mate.y = Math.round(mate.y);
      rects.set(mate.id, anchorRectOf(mate));
    }
    rects.set(id, anchorRectOf(node));
  }
  for (const [id, note] of memberNotes) {
    const at = placed.boxes.get(id)!;
    note.x = at.x;
    note.y = at.y;
  }
  // Boundaries behind what they hold, a nested one in front of its container — `buildStarter`'s rule.
  const depthOf = (id: string): number => {
    let depth = 0;
    let at = groups.get(id)?.parentId;
    while (at && groups.has(at)) {
      depth += 1;
      at = groups.get(at)?.parentId;
    }
    return depth;
  };
  const deepest = Math.max(0, ...[...groups.keys()].map(depthOf));
  for (const [id, group] of groups) {
    const rect = placed.groups.get(id)!;
    Object.assign(group, { x: rect.x, y: rect.y, width: rect.width, height: rect.height, z: depthOf(id) - deepest - 1 });
  }
  const anchors = assignAnchors(edges, rects, layout.direction);
  for (const edge of edges) {
    const a = anchors.get(edge.id);
    if (a) {
      edge.sourceAnchor = a.sourceAnchor;
      edge.targetAnchor = a.targetAnchor;
    }
  }
  snapLevelJogs(edges, elements, groups, JOG[layout.ties ?? 'align']);
  return { width: placed.width, height: placed.height };
}

/** Lays out one room (and, recursively, every inside view it declares). */
export function placeRoom(room: RoomSpec, layout: LayoutSpec, ctx: DescribeContext, primaryFlow?: string): PlacedRoom {
  const advisories: string[] = [];
  const groupNodes = new Map<string, DraftNode>();
  for (const g of room.groups) {
    groupNodes.set(
      g.id,
      createNode({ id: g.id, type: 'group', x: 0, y: 0, text: g.label, boundaryPreset: GROUP_KINDS[g.kind]?.preset ?? "boundary", ...(g.parent ? { parentId: g.parent } : {}) }),
    );
  }
  const elements = new Map<string, DraftNode>();
  for (const spec of room.nodes) {
    const node = elementFor(spec, ctx, spec.group);
    if (spec.inside) {
      const inner = placeRoom(spec.inside, layout, ctx);
      advisories.push(...inner.advisories.map((a) => `${spec.id} ▸ ${a}`));
      const inside = roomOf({ nodes: inner.nodes, edges: inner.edges, flows: inner.flows, viewport: { x: 0, y: 0, zoom: 1 }, ...(inner.level ? { level: inner.level } : {}) });
      if (inside) node.inside = inside;
    }
    elements.set(spec.id, node);
  }
  const edges: DraftEdge[] = [];
  for (const spec of room.relationships) {
    edges.push(connectorFor(spec, elements.get(spec.from)!, elements.get(spec.to)!, advisories));
  }
  // A note attached to an element or connector rides on it; one inside a boundary is laid out as a
  // member of it, so the boundary is sized to hold it. The rest are placed after (`placeNotes`).
  const memberNotes = new Map<string, DraftNode>();
  for (const spec of room.notes) {
    if (spec.attachTo) {
      const target = spec.attachTo;
      attachNote(target.kind === 'node' ? elements.get(target.id) : edges.find((e) => e.id === target.id), target.kind, spec);
    } else if (spec.group) {
      memberNotes.set(spec.id, noteNode(spec, ctx));
    }
  }

  const primary = room.flows.find((f) => f.id === (primaryFlow ?? layout.primaryFlow));
  const placed = arrangeParts({ elements, groups: groupNodes, memberNotes, edges, primaryEdges: new Set(primary?.steps.map((s) => s.relationship) ?? []) }, layout, ctx);
  const nodes = [...groupNodes.values(), ...elements.values(), ...memberNotes.values()];
  nodes.push(...placeNotes(room, nodes, edges, placed.width, placed.height, layout.direction, ctx));
  repairAnchors(edges, nodes, captionSizer(nodes, ctx));

  const flows = room.flows.map((spec) => {
    const flow = createFlow({ id: spec.id, title: spec.title });
    if (spec.color) flow.accent = spec.color;
    // Step ids follow from the flow's, so the same request always writes the same file.
    flow.steps = spec.steps.map((s, i): DraftFlowStep => ({ id: `${spec.id}.s${i + 1}`, edgeId: s.relationship, ...(s.caption ? { caption: s.caption } : {}) }));
    return flow;
  });

  return { nodes, edges, flows, ...(room.level ? { level: room.level } : {}), advisories };
}

/** Clear space kept around a placed block. */
const BLOCK_MARGIN = 28;

/**
 * Where a block of new elements goes: beside `host`, in the reading direction first, then the other
 * sides, further out each round — the first spot that overlaps nothing. A boundary counts as
 * something unless the block belongs in it (`intoGroup`, or one of its ancestors), which then grows
 * to hold it. Being drawn inside a boundary would read as belonging to it, so a block that doesn't
 * belong never lands in one. `undefined` when nothing near is free.
 */
export function placeBlock(
  view: DraftDocument,
  host: DraftNode,
  size: { width: number; height: number },
  direction: 'right' | 'down',
  intoGroup: string | undefined,
  firstGap = 72,
  upstream = false,
  /** Connector paths to keep clear of, as polylines — a note must not land on a line. */
  lines: readonly { x: number; y: number }[][] = [],
  /** Where, from the block's top-left, the connector to the host meets it: set on the host's own
   *  line, so the connector between them runs straight. The block's middle when not given. */
  lead?: { x: number; y: number },
): { x: number; y: number } | undefined {
  const allowed = new Set<string>();
  let at = intoGroup;
  while (at && !allowed.has(at)) {
    allowed.add(at);
    at = view.nodes.find((n) => n.id === at)?.parentId;
  }
  const blocked = view.nodes.filter((n) => !allowed.has(n.id));
  const free = (x: number, y: number) => {
    const box = { x: x - BLOCK_MARGIN / 2, y: y - BLOCK_MARGIN / 2, width: size.width + BLOCK_MARGIN, height: size.height + BLOCK_MARGIN };
    return (
      blocked.every(
        (n) =>
          x + size.width + BLOCK_MARGIN <= n.x ||
          n.x + n.width + BLOCK_MARGIN <= x ||
          y + size.height + BLOCK_MARGIN <= n.y ||
          n.y + n.height + BLOCK_MARGIN <= y,
      ) && lines.every((line) => line.every((point, k) => k === 0 || !segmentHitsBox(line[k - 1]!, point, box)))
    );
  };
  const line = lineOf(host);
  const cx = line.x - (lead ? lead.x - size.width / 2 : 0);
  const cy = line.y - (lead ? lead.y - size.height / 2 : 0);
  // Downstream of the host when the block is fed by it, upstream when the block feeds it: the new
  // part keeps the diagram's reading direction instead of looping back against it. An annotation
  // (`lines` given) sits across the flow instead — the reading direction is where connectors run.
  const forward = direction === 'right' ? ['right', 'below', 'above', 'left'] : ['below', 'right', 'left', 'above'];
  const backward = direction === 'right' ? ['left', 'below', 'above', 'right'] : ['above', 'left', 'right', 'below'];
  const across = direction === 'right' ? ['below', 'above', 'left', 'right'] : ['right', 'left', 'above', 'below'];
  const sides = lines.length ? across : upstream ? backward : forward;
  // A new part keeps the reading direction first (sliding along that side before trying another);
  // an annotation is about its host, so every side squarely beside it comes before any slid spot —
  // slid far enough along, a note sits beside the neighbour instead and reads as that one's.
  const order = lines.length
    ? [0, 1, -1, 2, -2].flatMap((slide) => sides.map((side) => ({ side, slide })))
    : sides.flatMap((side) => [0, 1, -1, 2, -2].map((slide) => ({ side, slide })));
  for (let ring = 0; ring < 8; ring += 1) {
    const gap = firstGap + ring * 48;
    for (const { side, slide } of order) {
      // Along the side, centred on the host first, then sliding either way.
      const step = slide * (side === 'right' || side === 'left' ? size.height / 2 + 24 : size.width / 2 + 24);
      const x = side === 'right' ? host.x + host.width + gap : side === 'left' ? host.x - gap - size.width : cx - size.width / 2 + step;
      const y = side === 'below' ? host.y + host.height + gap : side === 'above' ? host.y - gap - size.height : cy - size.height / 2 + step;
      if (free(x, y)) return { x: Math.round(x), y: Math.round(y) };
    }
  }
  return undefined;
}

/** A free note for a spec, at its natural height — inside its boundary when it names one. */
export function noteNode(spec: NoteSpec, ctx: DescribeContext): DraftNode {
  return sizeToFit(createNode({ id: spec.id, type: 'note', x: 0, y: 0, text: spec.text, noteKind: spec.kind, ...(spec.group ? { parentId: spec.group } : {}) }), ctx);
}

/**
 * Folds a note onto an element or connector as a native attachment, under the note's own id so it
 * can be edited or removed by it later. Full is a refusal, never a trim.
 */
export function attachNote(host: { id: string; attachments?: Attachment[] } | undefined, kind: 'node' | 'edge', spec: NoteSpec): void {
  if (!host) return;
  if (!hasAttachmentRoom(host, kind)) {
    throw new AgentError('LIMIT_EXCEEDED', `"${host.id}" can't hold another attachment.`, {
      hint: 'Put the note beside it instead (about without attach), or remove an attachment first.',
      details: { id: spec.id },
    });
  }
  host.attachments = [...(host.attachments ?? []), createAttachment({ id: spec.id, type: 'note', text: spec.text, noteKind: spec.kind })];
}

/** Notes beside what they're about when they say (placed clear of shapes and connectors, the way
 *  Intent Continuation places a companion); the rest in a column after the diagram. */
function placeNotes(room: RoomSpec, placed: DraftNode[], edges: DraftEdge[], width: number, height: number, direction: Direction, ctx: DescribeContext): DraftNode[] {
  const out: DraftNode[] = [];
  let loose = 0;
  // The connectors as they will be drawn, so a note never lands on one.
  const lines = edges.flatMap((edge) => {
    const drawn = drawnRoute(edge, placed, edges);
    return drawn ? [drawn.points] : [];
  });
  for (const spec of room.notes) {
    if (spec.attachTo || spec.group) continue;
    const note = noteNode(spec, ctx);
    const host = spec.near ? [...placed, ...out].find((n) => n.id === spec.near) : undefined;
    const doc: DraftDocument = { ...createDocument(), nodes: [...placed, ...out] };
    // Beside what it is about, but never inside a boundary it doesn't belong to.
    const at = host ? placeBlock(doc, host, { width: note.width, height: note.height }, direction, undefined, 32, false, lines.length ? lines : [[]]) : undefined;
    if (at) {
      note.x = Math.round(at.x);
      note.y = Math.round(at.y);
    } else if (direction === 'right') {
      note.x = Math.round(width + GUTTER);
      note.y = Math.round(loose);
      loose += note.height + 24;
    } else {
      note.x = Math.round(loose);
      note.y = Math.round(height + GUTTER);
      loose += note.width + 24;
    }
    out.push(note);
  }
  return out;
}
