/**
 * Where a presentation callout sits — pure, screen-space placement math.
 *
 * `popoverPlacement.ts` answers a simpler question (four sides of a rect against the window) for
 * editing popovers. A callout has more to respect: it must stay off the element it annotates and
 * that element's neighbours, off the connector's own line where it can, clear of the presentation
 * chrome, and close enough to its marker that the thread between them stays short. Tuned on its
 * own for the same reason `popoverPlacement.ts` keeps its clearances per consumer.
 *
 * Priorities when a perfect spot doesn't exist, in order: readable (never clipped or under chrome),
 * inside the canvas, near its owner, visibly threaded to it.
 */
import { clamp, overlapArea } from '../lib/math';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type CalloutPlacementName = 'above' | 'below' | 'above-right' | 'above-left' | 'right' | 'left' | 'docked';

export interface CalloutPlacementInput {
  kind: 'edge' | 'node';
  /** The chip or badge the thread leaves from. */
  marker: Box;
  /** What the callout is about: the node's own box, or the marker itself for a connector. */
  host: Box;
  /** A connector's chip row already hangs below its line — keep the callout on that side first. */
  preferBelow?: boolean;
  /** Never covered while any alternative exists: the host node, a connector's two endpoints. */
  avoid: readonly Box[];
  /** Covered as little as possible: other elements, and connector lines in short segments. */
  soft: readonly Box[];
  /** Presentation chrome — the flow bar, the exit button. Never covered. */
  exclusions: readonly Box[];
  /** The canvas, already inset by its margin. */
  bounds: Box;
  size: { width: number; height: number };
  /** The placement currently shown — kept on a crowded canvas unless moving uncovers noticeably more. */
  current?: CalloutPlacementName;
  /** The flow bar, for the docked fallback. */
  dockTo?: Box | null;
}

export interface CalloutLeader {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface CalloutPlacement {
  placement: CalloutPlacementName;
  /** Top-left of the callout, screen space. */
  x: number;
  y: number;
  /** From the marker's edge to the callout's nearest edge; null when docked or touching. */
  leader: CalloutLeader | null;
  /** Docked only: the tallest the callout may be and still clear the flow bar, when that's less
   *  than its size — the caller caps it there (its thread scrolls) rather than cover the bar. */
  maxHeight?: number;
}

/** Screen pixels between the marker and the callout — enough for the thread to read as one. */
export const CALLOUT_GAP = 18;
/** A thread longer than this stops reading as "belongs to" and starts reading as another edge. */
const MAX_LEADER = 160;
/** A clean placement also keeps its thread short — a long reach is only worth it in a crowd. */
const CLEAN_LEADER = 96;
/** Below this canvas width there's no room to float beside anything — dock above the flow bar. */
const MIN_FLOATING_WIDTH = 560;
const DOCK_GAP = 12;
/** Square pixels of extra coverage a callout accepts before leaving a placement it already holds. */
const SOFT_TOLERANCE = 400;

const EDGE_ORDER: CalloutPlacementName[] = ['above', 'below', 'above-right', 'above-left', 'right', 'left'];
const EDGE_ORDER_BELOW: CalloutPlacementName[] = ['below', 'above', 'above-right', 'above-left', 'right', 'left'];
const NODE_ORDER: CalloutPlacementName[] = ['above-right', 'above-left', 'right', 'left', 'below'];

function candidateOrigin(name: CalloutPlacementName, input: CalloutPlacementInput): { x: number; y: number } {
  const { marker, host, size, kind } = input;
  const markerCx = marker.x + marker.width / 2;
  const markerCy = marker.y + marker.height / 2;
  const top = Math.min(host.y, marker.y);
  const bottom = Math.max(host.y + host.height, marker.y + marker.height);
  const aboveY = top - CALLOUT_GAP - size.height;
  // Beside a node means level with the node; beside a connector, level with its marker.
  const sideY = (kind === 'node' ? host.y + host.height / 2 : markerCy) - size.height / 2;
  switch (name) {
    case 'above':
      return { x: markerCx - size.width / 2, y: aboveY };
    case 'below':
      return { x: markerCx - size.width / 2, y: bottom + CALLOUT_GAP };
    // A node's badge sits at its top-right corner, so "upper right" starts just over the badge and
    // opens outward; a connector has no corner, so its diagonal steps fully clear of the marker.
    case 'above-right':
      return kind === 'node'
        ? { x: marker.x - CALLOUT_GAP, y: aboveY }
        : { x: marker.x + marker.width + CALLOUT_GAP, y: marker.y - CALLOUT_GAP - size.height };
    case 'above-left':
      return kind === 'node'
        ? { x: marker.x + marker.width + CALLOUT_GAP - size.width, y: aboveY }
        : { x: marker.x - CALLOUT_GAP - size.width, y: marker.y - CALLOUT_GAP - size.height };
    case 'right':
      return { x: Math.max(host.x + host.width, marker.x + marker.width) + CALLOUT_GAP, y: sideY };
    case 'left':
      return { x: Math.min(host.x, marker.x) - CALLOUT_GAP - size.width, y: sideY };
    default:
      return { x: markerCx - size.width / 2, y: aboveY };
  }
}

/** The shortest segment between two boxes' edges — straight down/across where they overlap on an axis. */
export function leaderBetween(from: Box, to: Box): CalloutLeader | null {
  const axis = (aStart: number, aEnd: number, bStart: number, bEnd: number): [number, number] => {
    if (aEnd < bStart) return [aEnd, bStart];
    if (bEnd < aStart) return [aStart, bEnd];
    const mid = (Math.max(aStart, bStart) + Math.min(aEnd, bEnd)) / 2;
    return [mid, mid];
  };
  const [x1, x2] = axis(from.x, from.x + from.width, to.x, to.x + to.width);
  const [y1, y2] = axis(from.y, from.y + from.height, to.y, to.y + to.height);
  if (x1 === x2 && y1 === y2) return null;
  return { x1, y1, x2, y2 };
}

const leaderLength = (leader: CalloutLeader | null) =>
  leader ? Math.hypot(leader.x2 - leader.x1, leader.y2 - leader.y1) : 0;
/** `box` grown by `by` on every side (shrunk, for a negative `by`). */
export const inflate = (box: Box, by: number): Box => ({
  x: box.x - by,
  y: box.y - by,
  width: box.width + by * 2,
  height: box.height + by * 2,
});

interface Evaluated {
  name: CalloutPlacementName;
  rect: Box;
  leader: CalloutLeader | null;
  hard: number;
  soft: number;
  length: number;
}

/** Whether a thread would run through a box's interior — a line across the node it belongs to. */
function crosses(leader: CalloutLeader, box: Box): boolean {
  const inner = inflate(box, -2);
  for (let i = 1; i < 16; i++) {
    const t = i / 16;
    const x = leader.x1 + (leader.x2 - leader.x1) * t;
    const y = leader.y1 + (leader.y2 - leader.y1) * t;
    if (x > inner.x && x < inner.x + inner.width && y > inner.y && y < inner.y + inner.height) return true;
  }
  return false;
}

function evaluate(name: CalloutPlacementName, input: CalloutPlacementInput): Evaluated {
  const { bounds, size } = input;
  const origin = candidateOrigin(name, input);
  const rect: Box = {
    x: clamp(origin.x, bounds.x, bounds.x + bounds.width - size.width),
    y: clamp(origin.y, bounds.y, bounds.y + bounds.height - size.height),
    width: size.width,
    height: size.height,
  };
  // The marker itself counts as something to keep clear of — covering it cuts the thread.
  const hardBoxes = [...input.avoid, ...input.exclusions, inflate(input.marker, 4)];
  let hard = hardBoxes.reduce((sum, box) => sum + overlapArea(rect, box), 0);
  const soft = input.soft.reduce((sum, box) => sum + overlapArea(rect, box), 0);
  // The thread leaves the marker — unless that would draw it across the node it belongs to (a
  // callout beside or below a node whose badge sits on top), when it leaves the node's own edge.
  let leader = leaderBetween(input.marker, rect);
  if (leader && input.avoid.some((box) => crosses(leader!, box))) {
    leader = leaderBetween(input.host, rect);
    if (leader && input.avoid.some((box) => crosses(leader!, box))) hard += 1;
  }
  return { name, rect, leader, hard, soft, length: leaderLength(leader) };
}

function docked(input: CalloutPlacementInput): CalloutPlacement {
  const { bounds, size, dockTo } = input;
  const centerX = dockTo ? dockTo.x + dockTo.width / 2 : bounds.x + bounds.width / 2;
  // Between the canvas top and the flow bar — never over the bar's Previous/Next, however short
  // the canvas: a callout that doesn't fit there is capped to it.
  const floor = dockTo ? dockTo.y - DOCK_GAP : bounds.y + bounds.height;
  const room = Math.max(0, floor - bounds.y);
  const height = Math.min(size.height, room);
  return {
    placement: 'docked',
    x: clamp(centerX - size.width / 2, bounds.x, Math.max(bounds.x, bounds.x + bounds.width - size.width)),
    y: floor - height,
    leader: null,
    ...(size.height > room ? { maxHeight: room } : {}),
  };
}

export function placeCallout(input: CalloutPlacementInput): CalloutPlacement {
  const { bounds, size } = input;
  const tooBig = size.width > bounds.width || size.height > bounds.height;
  if (bounds.width < MIN_FLOATING_WIDTH || tooBig) return docked(input);

  const order = input.kind === 'node' ? NODE_ORDER : input.preferBelow ? EDGE_ORDER_BELOW : EDGE_ORDER;
  const candidates = order.map((name) => evaluate(name, input));
  const current = candidates.find((candidate) => candidate.name === input.current);
  const strict = (c: Evaluated) => c.hard === 0 && c.soft === 0 && c.length <= CLEAN_LEADER;
  const relaxed = (c: Evaluated) => c.hard === 0 && c.length <= MAX_LEADER;

  // The best clean spot always wins — even over one already held, so a callout placed mid camera
  // move settles where it belongs once the camera does.
  let chosen = candidates.find(strict);
  if (!chosen) {
    // Nothing is completely clear: cover as little of the diagram as possible, earlier candidates
    // winning ties, and stay put unless moving would uncover noticeably more — this is where a
    // held placement is kept, so a crowded canvas doesn't make the callout hop while panning.
    const usable = candidates.filter(relaxed);
    const best = usable.reduce<Evaluated | undefined>((min, c) => (!min || c.soft < min.soft ? c : min), undefined);
    chosen = current && best && relaxed(current) && current.soft <= best.soft + SOFT_TOLERANCE ? current : best;
  }
  if (!chosen) return docked(input);
  return { placement: chosen.name, x: chosen.rect.x, y: chosen.rect.y, leader: chosen.leader };
}

/** A polyline as thin boxes, one per segment — how a connector's line joins the `soft` set. */
export function segmentBoxes(points: readonly { x: number; y: number }[], thickness: number): Box[] {
  const boxes: Box[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const x = Math.min(a.x, b.x) - thickness / 2;
    const y = Math.min(a.y, b.y) - thickness / 2;
    boxes.push({ x, y, width: Math.abs(a.x - b.x) + thickness, height: Math.abs(a.y - b.y) + thickness });
  }
  return boxes;
}
