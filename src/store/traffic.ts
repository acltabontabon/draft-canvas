import { trafficScenario } from '../traffic/scenario';
import { findFlow } from '../document/flow';
import type { DraftEdge, DraftFlow, DraftNode } from '../document/types';
import { analyzeTraffic, mayHaveTraffic, type TrafficAnalysis, type TrafficInteraction, type TrafficNode } from '../traffic';
import type { EditorStore } from './editorStore';
import { nodeIndex } from './selectors';

/**
 * The editor's one door to traffic analysis: the room on screen, analyzed only while traffic is
 * showing, and only again when something the analysis reads has changed.
 *
 * Every node and connector asks for its own result on every store update while traffic shows, so
 * the answer is remembered against what it was computed from. A drag hands the store a new `nodes`
 * array every frame, but moving a shape changes nothing traffic reads — so a new array whose shapes
 * are the same kinds, with the same names, in the same order, keeps the analysis it already has
 * rather than running it again sixty times a second. Anything else (a connector drawn, a kind
 * changed, an undo, a collaborator's edit) gives a fresh one, so the canvas never shows an analysis
 * of a graph that has since changed.
 */
interface Memo {
  nodes: readonly DraftNode[];
  edges: readonly DraftEdge[];
  flow: DraftFlow | undefined;
  analysis: TrafficAnalysis;
}

let memo: Memo | null = null;

/** What the analysis reads from a shape. Position, size and styling are deliberately absent. */
function sameForTraffic(a: DraftNode, b: DraftNode): boolean {
  return (
    a === b ||
    (a.id === b.id &&
      a.type === b.type &&
      a.text === b.text &&
      a.serviceKind === b.serviceKind &&
      a.databaseKind === b.databaseKind &&
      a.queueKind === b.queueKind &&
      a.deliveryRole === b.deliveryRole &&
      a.componentKind === b.componentKind &&
      a.actorKind === b.actorKind)
  );
}

function sameNodes(a: readonly DraftNode[], b: readonly DraftNode[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (!sameForTraffic(a[index]!, b[index]!)) return false;
  return true;
}

function flowEdgeIds(flow: DraftFlow): Set<string> {
  const ids = new Set<string>();
  for (const step of flow.steps) {
    if (step.edgeId) ids.add(step.edgeId);
    for (const id of step.extraEdgeIds ?? []) ids.add(id);
  }
  return ids;
}

/** The flow traffic is scoped to, while it still exists; deleting it widens back to the room. */
export function trafficFlow(state: Pick<EditorStore, 'document' | 'traffic'>): DraftFlow | undefined {
  return state.traffic.active && state.traffic.flowId ? findFlow(state.document, state.traffic.flowId) : undefined;
}

/** The analysis of the room on screen, or `null` while traffic isn't showing. */
export function trafficOf(state: Pick<EditorStore, 'document' | 'traffic'>): TrafficAnalysis | null {
  if (!state.traffic.active) return null;
  const { nodes, edges } = state.document;
  const flow = trafficFlow(state);
  if (memo && memo.edges === edges && memo.flow === flow && sameNodes(memo.nodes, nodes)) {
    memo.nodes = nodes;
    return memo.analysis;
  }
  const analysis = analyzeTraffic({ nodes, edges, edgeIds: flow ? flowEdgeIds(flow) : undefined });
  memo = { nodes, edges, flow, analysis };
  return analysis;
}

/** One node's result — the object out of the analysis, so it is identity-stable between analyses. */
export function trafficNodeOf(state: Pick<EditorStore, 'document' | 'traffic'>, id: string): TrafficNode | undefined {
  return trafficOf(state)?.nodes.get(id);
}

/** Junctions some baseline route crosses, once per analysis — a Junction is never a resource, but a
 *  route through it is lit, so it stays lit with the route. */
const junctionsOnRoutes = new WeakMap<TrafficAnalysis, ReadonlySet<string>>();

function litJunctions(analysis: TrafficAnalysis): ReadonlySet<string> {
  let ids = junctionsOnRoutes.get(analysis);
  if (!ids) {
    const lit = new Set<string>();
    for (const interaction of analysis.interactions) {
      if (interaction.paths.possible > 0) for (const junctionId of interaction.junctionIds) lit.add(junctionId);
    }
    junctionsOnRoutes.set(analysis, (ids = lit));
  }
  return ids;
}

/**
 * How a shape reads while traffic shows: `top` and `raised` are where modeled paths concentrate,
 * `lit` takes part in traffic (an entry, a resource paths reach, a Junction a route crosses), and
 * `dim` takes no part. `null` while traffic isn't showing.
 */
export function trafficNodeReading(
  state: Pick<EditorStore, 'document' | 'traffic'>,
  id: string,
): 'top' | 'raised' | 'lit' | 'dim' | null {
  const analysis = trafficOf(state);
  if (!analysis) return null;
  const node = analysis.nodes.get(id);
  if (!node) return 'dim';
  if (node.tier !== 'none') return node.tier;
  if (node.role === 'junction') return litJunctions(analysis).has(id) ? 'lit' : 'dim';
  if (node.role === 'excluded') return 'dim';
  return node.isEntry || node.paths.possible > 0 ? 'lit' : 'dim';
}

/**
 * How a connector reads while traffic shows: `flow` carries modeled paths, `uncertain` only possible
 * ones, `shared` carries paths from more than one entry, `none` isn't traffic. `null` while traffic
 * isn't showing. A string, so only the connectors whose reading changes re-render.
 */
export function trafficEdgeOf(
  state: Pick<EditorStore, 'document' | 'traffic'>,
  id: string,
): 'flow' | 'shared' | 'uncertain' | 'none' | null {
  const analysis = trafficOf(state);
  if (!analysis) return null;
  const edge = analysis.edges.get(id);
  if (!edge || edge.participation === 'none') return 'none';
  if (edge.participation === 'uncertain') return 'uncertain';
  return edge.paths.definite > 1 ? 'shared' : 'flow';
}

/**
 * How the flow along a connector moves: which way along the drawn line the work travels, and how
 * many hops from an entry point it starts — the wave that spreads traffic out from where it enters.
 * `'f3'` flows with the arrow from three hops out, `'r0'` against it from an entry, `'s'` is drawn
 * still (past the motion budget on a very large diagram). A string, so connectors re-render only when
 * theirs changes. `null` for a connector with no traffic on it.
 */
export function trafficEdgeMotionOf(state: Pick<EditorStore, 'document' | 'traffic'>, id: string): string | null {
  const analysis = trafficOf(state);
  if (!analysis) return null;
  return motionOf(analysis).get(id) ?? null;
}

/** Past this many lit connectors the flow is drawn still: dozens of moving lines read as a picture,
 *  hundreds as noise, and each one is a repaint. */
export const MAX_FLOWING_EDGES = 150;
/** The wave's furthest step — anything deeper starts with the last of it. */
const MAX_WAVE_DEPTH = 8;

const motions = new WeakMap<TrafficAnalysis, Map<string, string>>();

function motionOf(analysis: TrafficAnalysis): Map<string, string> {
  const known = motions.get(analysis);
  if (known) return known;
  // A loop moves only where traffic actually reaches it — a loop nothing feeds stays still.
  const flows = (interaction: TrafficInteraction) =>
    interaction.paths.possible > 0 || (interaction.loop && (analysis.nodes.get(interaction.from)?.paths.possible ?? 0) > 0);
  // Hops from the nearest entry, over what carries traffic — breadth first, so a loop ends the walk.
  const next = new Map<string, string[]>();
  for (const interaction of analysis.interactions) {
    if (!flows(interaction)) continue;
    const list = next.get(interaction.from);
    if (list) list.push(interaction.to);
    else next.set(interaction.from, [interaction.to]);
  }
  const depth = new Map(analysis.entries.map((id) => [id, 0]));
  const pending = [...analysis.entries];
  for (let head = 0; head < pending.length; head += 1) {
    const at = pending[head]!;
    for (const to of next.get(at) ?? []) {
      if (depth.has(to)) continue;
      depth.set(to, depth.get(at)! + 1);
      pending.push(to);
    }
  }
  // The busiest connectors keep moving when there are too many to animate.
  const lit = analysis.interactions
    .filter(flows)
    .sort((a, b) => b.paths.possible - a.paths.possible || (a.id < b.id ? -1 : 1));
  const result = new Map<string, string>();
  for (const interaction of lit) {
    const reversed = new Set(interaction.reverseEdgeIds);
    const hops = Math.min(depth.get(interaction.from) ?? 0, MAX_WAVE_DEPTH);
    for (const edgeId of interaction.edgeIds) {
      if (result.has(edgeId)) continue;
      result.set(edgeId, result.size >= MAX_FLOWING_EDGES ? 's' : `${reversed.has(edgeId) ? 'r' : 'f'}${hops}`);
    }
  }
  motions.set(analysis, result);
  return result;
}

/**
 * Whether the room has anything traffic could be read from — what decides whether the status bar
 * offers it at all. Early-exit over the connectors with the room's shared node index, so it costs
 * next to nothing on a drag frame.
 */
export function roomMayHaveTraffic(state: Pick<EditorStore, 'document'>): boolean {
  const { nodes, edges } = state.document;
  if (edges.length === 0) return false;
  // Remembered per graph, like the analysis: a selection, a hover or a drag frame reuses it.
  const known = hintMemo.get(edges);
  if (known && sameNodes(known.nodes, nodes)) {
    known.nodes = nodes;
    return known.value;
  }
  const value = mayHaveTraffic(nodeIndex(nodes), edges);
  hintMemo.set(edges, { nodes, value });
  return value;
}

const hintMemo = new WeakMap<readonly DraftEdge[], { nodes: readonly DraftNode[]; value: boolean }>();

// Each node reads a cached string; no per-node graph walk or allocation on store updates.
const scenarios = new WeakMap<TrafficAnalysis, { multiplier: number; labels: Map<string, string> }>();

export function trafficScenarioOf(state: Pick<EditorStore, 'document' | 'traffic'>): Map<string, string> | null {
  const analysis = trafficOf(state);
  if (!analysis) return null;
  const multiplier = state.traffic.multiplier;
  const known = scenarios.get(analysis);
  if (known?.multiplier === multiplier) return known.labels;
  const labels = trafficScenario(analysis, multiplier);
  scenarios.set(analysis, { multiplier, labels });
  return labels;
}
