/**
 * What one presentation step is a picture *of* — the box the camera composes around, and the
 * architecture the story has to acknowledge on the way (a boundary the interaction crosses).
 *
 * Pure: reads resolved steps and nodes, never React or React Flow. The connector's own drawn
 * route is an optional input (`routeBoxes`, measured by the canvas from what is actually on
 * screen), because a bent or bundled connector can swing well outside the box its two endpoints
 * span, and a frame that cut its corner off would look like a mistake. Without it the endpoints
 * alone are used — which is also what a headless caller gets.
 */
import { boundsOf, type Bounds } from '../document/geometry';
import { lensNodeTier } from '../document/flow';
import type { DraftEdge, DraftFlow, DraftNode } from '../document/types';
import type { FlowPlaybackStep } from './useFlowPlayback';

export interface StepComposition {
  /** The flow-space box the camera frames. */
  bounds: Bounds;
  /** Boundaries (group nodes) the step's connectors cross, outermost first — ids. */
  crossed: string[];
  /** Ids of the shapes a connector of this step leaves from, and arrives at. */
  sources: string[];
  targets: string[];
}

/** A boundary's header strip: where its name is drawn, and all the camera needs of a large one. */
const BOUNDARY_HEADER_HEIGHT = 44;
const BOUNDARY_HEADER_WIDTH = 260;
/** A crossed boundary joins the frame only while it keeps the frame within this much growth;
 *  past it the strip alone is taken, and past *that* the boundary is left to the caption's chip. */
const BOUNDARY_GROWTH = 1.8;
const BOUNDARY_GROWTH_SLACK = 240;
/** Deep enough for any file `LIMITS.maxInsideDepth` allows and every nesting a boundary can have. */
const MAX_ANCESTRY = 64;

function rectOf(node: DraftNode): Bounds {
  return { x: node.x, y: node.y, width: node.width, height: node.height };
}

/** A node's enclosing boundaries, nearest first. Guarded against a cyclic `parentId` in a hand-edited file. */
export function ancestorsOf(nodesById: ReadonlyMap<string, DraftNode>, id: string): DraftNode[] {
  const chain: DraftNode[] = [];
  const seen = new Set<string>([id]);
  let current = nodesById.get(id);
  while (current?.parentId && chain.length < MAX_ANCESTRY) {
    const parent = nodesById.get(current.parentId);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    chain.push(parent);
    current = parent;
  }
  return chain;
}

/**
 * The boundaries a connector from `sourceId` to `targetId` crosses: every boundary around one end
 * that isn't also around the other, outermost first. Empty when both sit in the same place, which
 * includes both being at the top level.
 */
export function crossedBoundaries(nodesById: ReadonlyMap<string, DraftNode>, sourceId: string, targetId: string): DraftNode[] {
  const from = ancestorsOf(nodesById, sourceId).filter((node) => node.type === 'group');
  const to = ancestorsOf(nodesById, targetId).filter((node) => node.type === 'group');
  const shared = new Set(from.filter((node) => to.includes(node)).map((node) => node.id));
  // Outermost first: the boundary being left, then the one being entered, each from the outside in.
  return [...from.reverse(), ...to.reverse()].filter((node) => !shared.has(node.id));
}

function grows(base: Bounds, candidate: Bounds): boolean {
  const union = boundsOf([base, candidate])!;
  return (
    union.width > base.width * BOUNDARY_GROWTH + BOUNDARY_GROWTH_SLACK ||
    union.height > base.height * BOUNDARY_GROWTH + BOUNDARY_GROWTH_SLACK
  );
}

/**
 * The composition for one step. `null` for a step that puts nothing on stage (an
 * explicit-viewport-only step, which the camera shows verbatim instead).
 */
export function stepComposition(
  step: FlowPlaybackStep,
  nodesById: ReadonlyMap<string, DraftNode>,
  routeBoxes?: ReadonlyMap<string, Bounds>,
): StepComposition | null {
  const boxes: Bounds[] = step.extraNodes.map(rectOf);
  const sources: string[] = [];
  const targets: string[] = [];
  const crossed: DraftNode[] = [];
  for (const edge of step.edges) {
    const source = nodesById.get(edge.source);
    const target = nodesById.get(edge.target);
    if (source) {
      boxes.push(rectOf(source));
      sources.push(source.id);
    }
    if (target) {
      boxes.push(rectOf(target));
      targets.push(target.id);
    }
    const route = routeBoxes?.get(edge.id);
    if (route) boxes.push(route);
    if (source && target) {
      for (const boundary of crossedBoundaries(nodesById, source.id, target.id)) {
        if (!crossed.includes(boundary)) crossed.push(boundary);
      }
    }
  }
  const base = boundsOf(boxes);
  if (!base) return null;

  // A crossed boundary is part of the picture — whole when it is about the size of the
  // interaction, its named header when it is much larger, nothing when even that would push the
  // camera out too far to read the shapes (the caption still names it).
  let bounds = base;
  for (const boundary of crossed) {
    const whole = rectOf(boundary);
    if (!grows(base, whole)) {
      bounds = boundsOf([bounds, whole])!;
      continue;
    }
    const header: Bounds = {
      x: whole.x,
      y: whole.y,
      width: Math.min(whole.width, BOUNDARY_HEADER_WIDTH),
      height: Math.min(whole.height, BOUNDARY_HEADER_HEIGHT),
    };
    if (!grows(base, header)) bounds = boundsOf([bounds, header])!;
  }
  return { bounds, crossed: crossed.map((node) => node.id), sources, targets };
}

/**
 * The box a flow's overview frames: every member shape, with the boundaries that hold them — the
 * architectural context the opening establishes and the closing returns to. `null` for a flow
 * with no members on this canvas.
 */
export function flowOverviewBounds(
  nodes: readonly DraftNode[],
  edges: readonly DraftEdge[],
  flow: DraftFlow,
): Bounds | null {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const boxes: Bounds[] = [];
  for (const node of nodes) {
    if (lensNodeTier(flow, edges, node.id) !== 'member') continue;
    boxes.push(rectOf(node));
    for (const boundary of ancestorsOf(nodesById, node.id)) {
      if (boundary.type === 'group') boxes.push(rectOf(boundary));
    }
  }
  return boundsOf(boxes);
}
