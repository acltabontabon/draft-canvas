/**
 * Where connectors cross, and which of the two arcs over the other.
 *
 * Purely a rendering concern. Nothing here becomes a node, an anchor, a junction or a relationship;
 * nothing is persisted; the document is not consulted for anything but geometry. A bridge is a
 * detour in the *drawn* path only — `route.d` stays canonical, which is what keeps hit testing,
 * labels, attachment chips, step badges and the sequence exports exactly as they were. See
 * `edges/bridge.ts` for the arc itself.
 *
 * Shaped like `edges/bundles.ts`'s `routingPlan`, and for the same reason: this is a whole-document
 * derivation that every connector subscribes to, so it is memoized on the `(nodes, edges)` arrays
 * and hands back identity-stable results, letting zustand skip the re-render for every connector
 * whose crossings didn't change.
 */
import type { DraftEdge, DraftNode } from '../document/types';
import { routingPlan } from './bundles';
import { dashForEdge } from './kindStyle';
import { obstaclesForEdge } from './obstacles';
import { sameNodeGeometry } from './sameGeometry';
import { BRIDGE_RADIUS } from './bridge';
import {
  flattenPath,
  labelLaneOffset,
  laneIndex,
  rectOf,
  responseLaneFor,
  responseSpineFor,
  routeBetween,
  type Rect,
} from './routing';

/**
 * One place a connector crosses another, on the connector that will draw the arc.
 *
 * `nx`/`ny` is the direction the arc bows, fixed in world space (up for a horizontal run, left for
 * a vertical one) rather than derived from the line's direction of travel — otherwise the same
 * visual crossing would hump opposite ways depending on which end its connector was drawn from,
 * and the canvas and the exporter would have to agree on that by luck.
 *
 * `otherSource`/`otherTarget` are the crossed connector's own endpoints, carried here so that a
 * drag can drop crossings whose geometry has gone stale without looking anything up — the same
 * trick `withoutNodes` uses for obstacles.
 */
export interface Crossing {
  x: number;
  y: number;
  nx: number;
  ny: number;
  otherSource: string;
  otherTarget: string;
}

export interface CrossingPlan {
  /** The crossings this connector draws an arc over. Identity-stable, and the *same* empty array
   *  every time for a connector that crosses nothing, so subscribers don't re-render. */
  crossingsFor(edgeId: string): readonly Crossing[];
}

const NO_CROSSINGS: readonly Crossing[] = Object.freeze([]);
/** What `compute` hands back: the plan, and the per-connector lists behind it, kept so the next plan
 *  can reuse the ones that did not change. */
interface ComputedPlan extends CrossingPlan {
  lists: ReadonlyMap<string, readonly Crossing[]>;
}

const NO_LISTS: ReadonlyMap<string, readonly Crossing[]> = new Map();
const EMPTY_PLAN: ComputedPlan = { crossingsFor: () => NO_CROSSINGS, lists: NO_LISTS };

/**
 * How far a crossing must sit from anything that would make its arc unreadable — a connector's own
 * endpoints, its bends, a node's edge. Comfortably clear of `ARROW_LENGTH` (9), so an arc can never
 * land on an arrowhead. A consequence worth knowing: `getSmoothStepPath` leaves only about ten
 * units of straight run at each end, so crossings right at a busy hub are structurally unbridgeable
 * — which is the right answer anyway, since an arc there would be indistinguishable from the join.
 */
const BRIDGE_CLEARANCE = 14;

/**
 * Some connector kinds draw a glyph *on* the line at their label point rather than beside it: an
 * async call's "cable break" ticks, which even erase a gap in the line to sit in, and a
 * conditional's diamond. An arc there is either clipped by that glyph's own mask or reads as a
 * stray third mark, so its neighbourhood is left alone.
 *
 * Note this deliberately does *not* cover ordinary labels and relationship captions. Those float
 * clear of the line by `LABEL_LINE_GAP`, well above an arc's own height, and excluding a radius
 * around every connector's midpoint would refuse a bridge at exactly the place crossings most often
 * happen.
 */
const GLYPH_CLEARANCE = 12;

/** A bend of less than this (in radians) is not a bend. `getSmoothStepPath` emits collinear
 *  waypoints along a straight run — `M460 80L460 100L460 350L460 620` is one unbroken line — and
 *  `flattenPath` marks each as a corner, so without this an arc would be refused along stretches
 *  that are perfectly straight. */
const BEND_ANGLE = 0.15;

/** Two segments within this of parallel are treated as running together rather than crossing. This
 *  is what keeps a pair of connectors sharing a bundle trunk — or any two collinear runs — from
 *  sprouting a row of humps where they overlap. */
const PARALLEL_EPSILON = 0.12;

/** How much more horizontal one segment must be than the other before orientation decides who
 *  bridges. Inside the band the stable key decides instead. Without it, two lines crossing near 45°
 *  swap the arc back and forth on sub-pixel movement. Hysteresis bought with arithmetic rather than
 *  with remembered state, as `TRUNK_QUANTUM` does for trunk placement. */
const ORIENTATION_BAND = 0.08;

/**
 * How close two crossings on *different* connectors may be before neither is drawn.
 *
 * A hump answers one question — "do these two lines meet?" — and answers it well. Where three or
 * more lines converge within a hump's own width, humps on two different connectors interleave into
 * a knot that is harder to read than the plain crossing was, and the question they were answering
 * was not really the reader's question anyway. So that neighbourhood is left alone.
 *
 * Deliberately only across connectors. One line hopping several others in quick succession is the
 * good case, and it is handled by merging those into a single wider hump, not by dropping them.
 */
const CLUSTER_RADIUS = BRIDGE_RADIUS * 2;

/** Cell size for the segment grid, in flow units — the same idea as `obstacles.ts`'s grid, sized
 *  down because a connector segment is a good deal smaller than a diagram. */
const CELL = 256;

/** Past this many segment-pair visits the plan gives up and draws no bridges at all. Readability
 *  help is worth a bounded cost a commit and not more; "no bridges" is a correct diagram, exactly as
 *  "route independently" is the correct fallback when bundle planning gets too large. A visit is a
 *  couple of integer compares now (`cx0`/`cy0` pick the one cell a pair is tested in), which is why
 *  this is ten times what it once was: a diagram of 800 connectors used to hit the old limit and
 *  lose every bridge at once. */
const MAX_CROSSING_OPS = 4_000_000;

/** And past this many connectors, don't even route. A diagram this dense has bigger problems than
 *  crossings, and the whole-document routing pass is the real cost here, not the pair tests. */
const MAX_CROSSING_EDGES = 1200;

interface Vertex {
  x: number;
  y: number;
  corner: boolean;
}

interface Line {
  /** The connector this line belongs to. A request/response pair's two halves share it, which is
   *  what makes them one relationship that never crosses itself. */
  edgeId: string;
  source: string;
  target: string;
  /** Whether this line can draw an arc: solid connectors only. A dashed line's arc would be
   *  rendered as two or three detached fragments — a dash period is 5 to 14 units against an
   *  8-unit span — and read as damage rather than as a bridge. A dashed line crossing a solid one
   *  still gets bridged *over*; it just never does the bridging. */
  ownable: boolean;
  points: Vertex[];
  ends: { x: number; y: number }[];
  /** Where the line actually changes direction — not every vertex, see `BEND_ANGLE`. */
  bends: { x: number; y: number }[];
  /** Points where this connector draws a glyph on the line itself, if any. */
  glyphs: { x: number; y: number }[];
  /** The tie-break identity. A bundle member answers with its *spine*, never its own id, so every
   *  member of a shared trunk resolves a crossing on that trunk the same way. Otherwise one member
   *  could win ownership where another lost it, and the shared run would be half-bridged. */
  key: string;
}

const near = (a: { x: number; y: number }, b: { x: number; y: number }, within: number) =>
  Math.abs(a.x - b.x) <= within && Math.abs(a.y - b.y) <= within && Math.hypot(a.x - b.x, a.y - b.y) <= within;

/** The vertices where a polyline genuinely turns, ignoring the collinear waypoints the step router
 *  leaves along a straight run. */
function bendsOf(points: readonly Vertex[]): { x: number; y: number }[] {
  const bends: { x: number; y: number }[] = [];
  for (let i = 1; i + 1 < points.length; i += 1) {
    const previous = points[i - 1]!;
    const here = points[i]!;
    const next = points[i + 1]!;
    const before = Math.atan2(here.y - previous.y, here.x - previous.x);
    const after = Math.atan2(next.y - here.y, next.x - here.x);
    let turn = Math.abs(after - before);
    if (turn > Math.PI) turn = 2 * Math.PI - turn;
    if (turn > BEND_ANGLE) bends.push({ x: here.x, y: here.y });
  }
  return bends;
}

/** Where a connector draws something *on* its own line, which an arc must not land under. Only a
 *  few kinds do; everything else annotates beside the line, clear of an arc's height. */
function glyphsOf(edge: DraftEdge, at: { x: number; y: number }): { x: number; y: number }[] {
  if (edge.kind === 'async' && !edge.async) return [at];
  if (edge.kind === 'conditional' || edge.kind === 'event') return [at];
  return [];
}

/** Routes every connector once, exactly as the renderers do, and reduces each to a polyline plus
 *  the few points an arc must keep away from. */
function linesOf(nodes: readonly DraftNode[], edges: readonly DraftEdge[], obstacleNodes: readonly DraftNode[]): Line[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const lanes = laneIndex(edges);
  const plan = routingPlan(nodes, edges);
  const lines: Line[] = [];

  for (const edge of edges) {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target) continue;
    const lane = lanes.get(edge.id)?.offset ?? 0;
    const spine = plan.spineFor(edge.id);
    const obstacles = obstaclesForEdge(obstacleNodes, edge.source, edge.target);
    const sourceRect = rectOf(source);
    const targetRect = rectOf(target);

    const route = routeBetween(sourceRect, targetRect, edge.routing, {
      anchors: { source: edge.sourceAnchor, target: edge.targetAnchor },
      lane,
      obstacles,
      spine,
    });
    const points = flattenPath(route.d);
    if (points.length >= 2) {
      // Both renderers draw the label cluster at the *lane-nudged* point, not at `route.labelX`
      // — on a laned connector those are up to `LABEL_LANE_SPACING` apart.
      const nudge = labelLaneOffset(route.source.side, route.target.side, lane);
      const labelPoint = { x: route.labelX + nudge.x, y: route.labelY + nudge.y };
      lines.push({
        edgeId: edge.id,
        source: edge.source,
        target: edge.target,
        ownable: dashForEdge(edge) === undefined,
        points,
        ends: [route.source, route.target],
        bends: bendsOf(points),
        glyphs: glyphsOf(edge, labelPoint),
        key: spine ? `spine:${spine.id}` : `edge:${edge.id}`,
      });
    }

    // A request/response connector's reply line is a second path on the canvas, so it must be
    // crossable — but it is always dashed (`RESPONSE_DASH`), so it never draws an arc of its own.
    if (edge.hasResponse) {
      const responseRoute = routeBetween(targetRect, sourceRect, edge.routing, {
        anchors: { source: edge.targetAnchor, target: edge.sourceAnchor },
        lane: responseLaneFor(lane),
        obstacles,
        spine: responseSpineFor(spine),
      });
      const responsePoints = flattenPath(responseRoute.d);
      if (responsePoints.length >= 2) {
        lines.push({
          edgeId: edge.id,
          source: edge.source,
          target: edge.target,
          ownable: false,
          points: responsePoints,
          ends: [responseRoute.source, responseRoute.target],
          bends: [],
          glyphs: [],
          key: `response:${edge.id}`,
        });
      }
    }
  }
  return lines;
}

/** The node boxes an arc must not poke out from under. Nodes paint over connectors, so a crossing
 *  inside a box is invisible — but an arc just inside one would show as an unexplained bump along
 *  its edge. Boundaries are excluded: they are translucent and paint *behind* connectors. */
function blockingRects(nodes: readonly DraftNode[]): Rect[] {
  return nodes.filter((node) => node.type !== 'group').map(rectOf);
}

interface SegmentRef {
  line: number;
  index: number;
  /** The lowest grid cell this segment's box covers. Two segments are tested in the first cell
   *  *both* cover — `max` of these — which is what lets a pair reached from several cells be tested
   *  exactly once without remembering which pairs have been. */
  cx0: number;
  cy0: number;
}

interface Cell {
  cx: number;
  cy: number;
  refs: SegmentRef[];
}

/** Grid cells as one number, so a lookup allocates no string. Cells are far inside ±32768. */
const cellKey = (cx: number, cy: number) => (cx + 32768) * 65536 + (cy + 32768);

/**
 * The blocking rects bucketed by grid cell, each covering everything within `margin` of it, so "is
 * this point inside or near any node" reads one cell rather than every node on the canvas.
 */
function rectGrid(rects: readonly Rect[], margin: number): Map<number, Rect[]> {
  const grid = new Map<number, Rect[]>();
  for (const rect of rects) {
    const x0 = Math.floor((rect.x - margin) / CELL);
    const x1 = Math.floor((rect.x + rect.width + margin) / CELL);
    const y0 = Math.floor((rect.y - margin) / CELL);
    const y1 = Math.floor((rect.y + rect.height + margin) / CELL);
    for (let cx = x0; cx <= x1; cx += 1) {
      for (let cy = y0; cy <= y1; cy += 1) {
        const key = cellKey(cx, cy);
        const bucket = grid.get(key);
        if (bucket) bucket.push(rect);
        else grid.set(key, [rect]);
      }
    }
  }
  return grid;
}

/** Which of the two lines draws the arc, or `null` if neither can. Orientation decides — the more
 *  horizontal run goes over, the convention every diagramming tool shares — but only when it can
 *  actually draw there; otherwise the other line takes it. */
function chooseOwner(
  a: Line,
  b: Line,
  horizontalityA: number,
  horizontalityB: number,
  drawableA: boolean,
  drawableB: boolean,
): Line | null {
  if (!drawableA && !drawableB) return null;
  if (!drawableA) return b;
  if (!drawableB) return a;
  if (horizontalityA - horizontalityB > ORIENTATION_BAND) return a;
  if (horizontalityB - horizontalityA > ORIENTATION_BAND) return b;
  return a.key < b.key ? a : b;
}

function compute(
  nodes: readonly DraftNode[],
  edges: readonly DraftEdge[],
  obstacleNodes: readonly DraftNode[],
  previous?: ReadonlyMap<string, readonly Crossing[]>,
): ComputedPlan {
  if (edges.length < 2 || edges.length > MAX_CROSSING_EDGES) return EMPTY_PLAN;
  const lines = linesOf(nodes, edges, obstacleNodes);
  if (lines.length < 2) return EMPTY_PLAN;
  const blocking = rectGrid(blockingRects(nodes), BRIDGE_CLEARANCE);

  // A uniform grid over segments rather than every pair of connectors: pair counts grow with the
  // square of the *segment* count, and a stepped connector flattens to a dozen or more.
  const cells = new Map<number, Cell>();
  lines.forEach((line, lineIndex) => {
    for (let i = 0; i + 1 < line.points.length; i += 1) {
      const p = line.points[i]!;
      const q = line.points[i + 1]!;
      const x0 = Math.floor(Math.min(p.x, q.x) / CELL);
      const x1 = Math.floor(Math.max(p.x, q.x) / CELL);
      const y0 = Math.floor(Math.min(p.y, q.y) / CELL);
      const y1 = Math.floor(Math.max(p.y, q.y) / CELL);
      const ref: SegmentRef = { line: lineIndex, index: i, cx0: x0, cy0: y0 };
      for (let cx = x0; cx <= x1; cx += 1) {
        for (let cy = y0; cy <= y1; cy += 1) {
          const key = cellKey(cx, cy);
          const cell = cells.get(key);
          if (cell) cell.refs.push(ref);
          else cells.set(key, { cx, cy, refs: [ref] });
        }
      }
    }
  });

  const found = new Map<string, Crossing[]>();
  /** Each owning connector's tie-break identity (its spine for a bundle member) — see `crowded`. */
  const keyOf = new Map<string, string>();
  let ops = 0;

  for (const cell of cells.values()) {
    const refs = cell.refs;
    for (let i = 0; i < refs.length; i += 1) {
      const refA = refs[i]!;
      for (let j = i + 1; j < refs.length; j += 1) {
        if ((ops += 1) > MAX_CROSSING_OPS) return EMPTY_PLAN;
        const refB = refs[j]!;
        // A segment pair is tested in the first cell both cover, and skipped in the others — the
        // same pair is reached from every cell the two boxes share.
        if (cell.cx !== (refA.cx0 > refB.cx0 ? refA.cx0 : refB.cx0)) continue;
        if (cell.cy !== (refA.cy0 > refB.cy0 ? refA.cy0 : refB.cy0)) continue;
        const a = lines[refA.line]!;
        const b = lines[refB.line]!;
        // The same connector never crosses itself, and neither half of a request/response pair
        // crosses the other: they are one relationship drawn as two lines.
        if (a.edgeId === b.edgeId) continue;

        const crossing = intersect(a, refA.index, b, refB.index);
        if (!crossing) continue;
        const { x, y, horizontalityA, horizontalityB } = crossing;

        // Two connectors that meet at a shape, or at each other's ends, are joined there as far as
        // a reader is concerned — an arc would claim otherwise. This one rule also keeps arcs off
        // arrowheads. Connectors that leave the same shape and genuinely cross further out are a
        // real crossing and still get one.
        if (a.ends.some((end) => near(end, { x, y }, BRIDGE_CLEARANCE))) continue;
        if (b.ends.some((end) => near(end, { x, y }, BRIDGE_CLEARANCE))) continue;
        if (insideAnyRect(blocking, x, y)) continue;
        if (atBend(a, x, y) || atBend(b, x, y)) continue;

        const drawableA = drawable(a, x, y);
        const drawableB = drawable(b, x, y);
        const owner = chooseOwner(a, b, horizontalityA, horizontalityB, drawableA, drawableB);
        if (!owner) continue;
        const other = owner === a ? b : a;
        const ownerIndex = owner === a ? refA.index : refB.index;
        const normal = bowOf(owner.points[ownerIndex]!, owner.points[ownerIndex + 1]!);

        keyOf.set(owner.edgeId, owner.key);
        const list = found.get(owner.edgeId);
        const entry: Crossing = {
          x,
          y,
          nx: normal.x,
          ny: normal.y,
          otherSource: other.source,
          otherTarget: other.target,
        };
        // One foreign line crossing a bundle's shared trunk meets it once per member, at the same
        // point every time. Those are one crossing, not N stacked arcs.
        if (!list) found.set(owner.edgeId, [entry]);
        else if (!list.some((existing) => near(existing, entry, 0.5))) list.push(entry);
      }
    }
  }

  const clusters = crossingHash(found, keyOf);
  const result = new Map<string, readonly Crossing[]>();
  for (const [edgeId, list] of found) {
    const kept = list.filter((crossing) => !crowded(crossing, keyOf.get(edgeId) ?? edgeId, clusters));
    if (kept.length === 0) continue;
    // A connector subscribes to its own list by identity, so a list that has not changed has to come
    // back as the very same array — otherwise every commit hands every crossed connector a "new"
    // list, and every one of them re-renders for a move that did not touch it. The same interning
    // `internSpine` does for a bundle's trunk.
    const before = previous?.get(edgeId);
    result.set(edgeId, before && sameCrossings(before, kept) ? before : Object.freeze(kept));
  }
  return planOf(result);
}

/** Built outside `compute` on purpose. A closure created inside it would share `compute`'s scope with
 *  `cells` and `clusters` — the segment grid and the crowding hash — and keep both alive for as long
 *  as the plan is. Undo history holds a plan per step, so that was a few hundred KB of scratch
 *  structure per edit at Medium and over a megabyte at Large, all of it dead the moment `compute`
 *  returned. */
function planOf(lists: ReadonlyMap<string, readonly Crossing[]>): ComputedPlan {
  return { crossingsFor: (edgeId) => lists.get(edgeId) ?? NO_CROSSINGS, lists };
}

function sameCrossings(a: readonly Crossing[], b: readonly Crossing[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.x !== y.x || x.y !== y.y || x.nx !== y.nx || x.ny !== y.ny || x.otherSource !== y.otherSource || x.otherTarget !== y.otherTarget) {
      return false;
    }
  }
  return true;
}

/** Whether a point is inside, or within `BRIDGE_CLEARANCE` of, any blocking rect. */
function insideAnyRect(grid: Map<number, Rect[]>, x: number, y: number): boolean {
  const bucket = grid.get(cellKey(Math.floor(x / CELL), Math.floor(y / CELL)));
  if (!bucket) return false;
  for (const rect of bucket) if (insideRect(rect, x, y, BRIDGE_CLEARANCE)) return true;
  return false;
}

interface Placed {
  key: string;
  x: number;
  y: number;
}

/** Every crossing bucketed by a cell one cluster radius wide, so "is anything else near here" reads
 *  nine cells instead of every connector's whole list. */
function crossingHash(found: Map<string, Crossing[]>, keyOf: ReadonlyMap<string, string>): Map<number, Placed[]> {
  const hash = new Map<number, Placed[]>();
  for (const [edgeId, list] of found) {
    const owner = keyOf.get(edgeId) ?? edgeId;
    for (const { x, y } of list) {
      const key = cellKey(Math.floor(x / CLUSTER_RADIUS), Math.floor(y / CLUSTER_RADIUS));
      const bucket = hash.get(key);
      if (bucket) bucket.push({ key: owner, x, y });
      else hash.set(key, [{ key: owner, x, y }]);
    }
  }
  return hash;
}

/** Whether another connector also wants a hump within one hump's width of this one — see
 *  `CLUSTER_RADIUS`. Compared by tie-break key, not connector id: the members of a bundle's shared
 *  trunk all bridge the same crossing on the same line, which is one hump, not a crowd of them. */
function crowded(crossing: Crossing, key: string, hash: Map<number, Placed[]>): boolean {
  const cx = Math.floor(crossing.x / CLUSTER_RADIUS);
  const cy = Math.floor(crossing.y / CLUSTER_RADIUS);
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      const bucket = hash.get(cellKey(cx + dx, cy + dy));
      if (!bucket) continue;
      for (const other of bucket) {
        if (other.key !== key && near(other, crossing, CLUSTER_RADIUS)) return true;
      }
    }
  }
  return false;
}

/**
 * Which way the hump arcs off a segment: square to the line, so it reads as the line stepping over
 * rather than leaning, and on a diagonal just as much as on a horizontal run.
 *
 * Of a segment's two perpendiculars this takes the upward one, or the leftward one where the
 * segment is vertical and neither is upward. Settling it from the line's *position* and never from
 * its direction of travel is what stops the same crossing humping opposite ways depending on which
 * end its connector happens to have been drawn from — and lets the canvas and the exporter agree
 * without having to share anything but the geometry.
 */
function bowOf(p: { x: number; y: number }, q: { x: number; y: number }): { x: number; y: number } {
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const length = Math.hypot(dx, dy) || 1;
  const nx = -dy / length;
  const ny = dx / length;
  if (Math.abs(ny) > 1e-6) return ny < 0 ? { x: nx, y: ny } : { x: -nx, y: -ny };
  return nx < 0 ? { x: nx, y: ny } : { x: -nx, y: -ny };
}

function insideRect(rect: Rect, x: number, y: number, margin: number): boolean {
  return (
    x > rect.x - margin && x < rect.x + rect.width + margin && y > rect.y - margin && y < rect.y + rect.height + margin
  );
}

/**
 * Whether a point sits where this line turns.
 *
 * Checked for *both* lines of a pair, not just the one that would draw. Where one line corners onto
 * another, or two run along the same corridor and one peels off, the router's own rounded corner
 * technically crosses its neighbour — but nobody reads that as two lines crossing, and a hump there
 * decorates a corner instead of clarifying anything. It is also what keeps a shared vertical
 * corridor, which every stepped connector between two columns of shapes uses, from sprouting humps
 * at each place a connector leaves it.
 */
function atBend(line: Line, x: number, y: number): boolean {
  return line.bends.some((bend) => near(bend, { x, y }, BRIDGE_CLEARANCE));
}

/** Whether this line could host an arc at this point: solid, and clear of any glyph it draws on
 *  itself. Bends are ruled out for the pair as a whole by `atBend`. */
function drawable(line: Line, x: number, y: number): boolean {
  if (!line.ownable) return false;
  if (line.glyphs.some((glyph) => near(glyph, { x, y }, GLYPH_CLEARANCE))) return false;
  return true;
}

/**
 * Exact segment intersection — no tolerance band, so two connectors that merely pass close to each
 * other are left alone. Near-parallel pairs are rejected outright rather than resolved to a point:
 * two runs travelling together (a shared trunk, a pair of lanes) have no single crossing, and
 * treating them as though they did produces a string of arcs along the overlap.
 */
function intersect(
  a: Line,
  indexA: number,
  b: Line,
  indexB: number,
): { x: number; y: number; horizontalityA: number; horizontalityB: number } | null {
  const p = a.points[indexA]!;
  const p2 = a.points[indexA + 1]!;
  const q = b.points[indexB]!;
  const q2 = b.points[indexB + 1]!;
  const rx = p2.x - p.x;
  const ry = p2.y - p.y;
  const sx = q2.x - q.x;
  const sy = q2.y - q.y;
  const denominator = rx * sy - ry * sx;
  const lengthA = Math.hypot(rx, ry);
  const lengthB = Math.hypot(sx, sy);
  if (lengthA === 0 || lengthB === 0) return null;
  if (Math.abs(denominator) / (lengthA * lengthB) < PARALLEL_EPSILON) return null;

  const t = ((q.x - p.x) * sy - (q.y - p.y) * sx) / denominator;
  const u = ((q.x - p.x) * ry - (q.y - p.y) * rx) / denominator;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;

  return {
    x: p.x + rx * t,
    y: p.y + ry * t,
    horizontalityA: Math.abs(rx) / lengthA,
    horizontalityB: Math.abs(sx) / lengthB,
  };
}

const planCache = new WeakMap<readonly DraftNode[], WeakMap<readonly DraftEdge[], CrossingPlan>>();

/** The lists of the plan most recently built for the canvas, for `compute` to reuse — see there. Only
 *  ever the cached path's: an export or a mid-gesture plan is for a different set of obstacles and
 *  would only make the canvas's next plan find nothing to reuse. */
let lastLists: ReadonlyMap<string, readonly Crossing[]> = NO_LISTS;

/** The inputs and result of that same most recent canvas plan — see `crossingPlan`. */
let lastBuilt: { nodes: readonly DraftNode[]; edges: readonly DraftEdge[]; plan: ComputedPlan } | null = null;

/**
 * Where each connector crosses another, for the whole document.
 *
 * `obstacleNodes` is the set connectors are routed against, which is `nodes` except while a gesture
 * is in flight — the exporter drops the nodes being moved, exactly as the canvas does. It has to be
 * passed rather than assumed, or this would plan against routes nobody actually draws. Passing a
 * distinct array also (correctly) bypasses the cache for the duration of the gesture.
 */
export function crossingPlan(
  nodes: readonly DraftNode[],
  edges: readonly DraftEdge[],
  obstacleNodes: readonly DraftNode[] = nodes,
): CrossingPlan {
  if (obstacleNodes !== nodes) return compute(nodes, edges, obstacleNodes);
  const byNodes = planCache.get(nodes);
  const cached = byNodes?.get(edges);
  if (cached) return cached;

  // An edit that moved nothing — a rename, a colour, a note's text — is a new `nodes` array and so,
  // by identity, a new plan, for an answer that cannot have changed. Crossings are where connectors
  // are, and where they are depends only on the shapes' places, so the plan already built stands.
  const previous = lastBuilt;
  const plan =
    previous && previous.edges === edges && sameNodeGeometry(previous.nodes, nodes)
      ? previous.plan
      : compute(nodes, edges, obstacleNodes, lastLists);
  lastBuilt = { nodes, edges, plan };
  lastLists = plan.lists;
  if (byNodes) byNodes.set(edges, plan);
  else planCache.set(nodes, new WeakMap([[edges, plan]]));
  return plan;
}

/** Drops the crossings a gesture has made unreliable: those against a connector attached to a node
 *  being moved, whose live route has left the one this plan was built from. The plan itself is
 *  built from the committed document and does not recompute mid-gesture — positions only reach the
 *  store when the drag ends. Returns the original array when nothing is dropped, so an untouched
 *  connector keeps its identity and does not re-render — but a *partial* drop is a new array every
 *  call, so anything subscribing to the result must compare it shallowly (`useShallow`). */
export function withoutMoving(crossings: readonly Crossing[], moving: ReadonlySet<string>): readonly Crossing[] {
  if (moving.size === 0 || crossings.length === 0) return crossings;
  const kept = crossings.filter((crossing) => !moving.has(crossing.otherSource) && !moving.has(crossing.otherTarget));
  return kept.length === crossings.length ? crossings : kept.length === 0 ? NO_CROSSINGS : kept;
}

export { BRIDGE_CLEARANCE, GLYPH_CLEARANCE, NO_CROSSINGS };
