import type { DraftEdge, DraftFlow, DraftNode } from '../document/types';
import { analyzeTraffic, mayHaveTraffic, outageOf, outageReview, type Outage, type OutageEdgeState, type OutageReview, type OutageState, type TrafficAnalysis } from '../traffic';
import type { EditorStore } from './editorStore';
import { nodeIndex } from './selectors';

/**
 * The editor's one door to an outage walk: the room on screen, read only while a walk is open, and
 * only again when something the reading depends on has changed.
 *
 * Every node and connector asks for its own state on every store update while a walk shows, so the
 * answer is remembered against what it was computed from. A drag hands the store a new `nodes`
 * array every frame, but moving a shape changes nothing an outage reads — so a new array whose
 * shapes are the same kinds, with the same names, technology and instance counts, in the same
 * order, keeps the reading it already has rather than running it again sixty times a second.
 * Anything else (a connector drawn, a kind changed, an undo, a collaborator's edit) gives a fresh
 * one, so the canvas never shows the outage of a graph that has since changed.
 *
 * Three readings come off that one analysis, each kept against it: the outage of whatever is taken
 * down (`outageIn`), which also depends on the room's flows; the review of everything at once while
 * nothing is (`outageReviewIn`); and the junctions lit along routes that carry on.
 */
type View = Pick<EditorStore, 'document' | 'outage'>;

interface Memo {
  nodes: readonly DraftNode[];
  edges: readonly DraftEdge[];
  analysis: TrafficAnalysis;
}

let memo: Memo | null = null;

/** What an outage reads from a shape. Position, size and styling are deliberately absent. */
function sameForOutage(a: DraftNode, b: DraftNode): boolean {
  return (
    a === b ||
    (a.id === b.id &&
      a.type === b.type &&
      a.text === b.text &&
      a.parentId === b.parentId &&
      a.serviceKind === b.serviceKind &&
      a.databaseKind === b.databaseKind &&
      a.queueKind === b.queueKind &&
      a.deliveryRole === b.deliveryRole &&
      a.componentKind === b.componentKind &&
      a.actorKind === b.actorKind &&
      a.technology === b.technology &&
      a.replicas === b.replicas)
  );
}

function sameNodes(a: readonly DraftNode[], b: readonly DraftNode[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (!sameForOutage(a[index]!, b[index]!)) return false;
  return true;
}

/** How work travels through the room on screen, or `null` while no walk is open. */
export function runtimeOf(state: View): TrafficAnalysis | null {
  if (!state.outage.active) return null;
  const { nodes, edges } = state.document;
  if (memo && memo.edges === edges && sameNodes(memo.nodes, nodes)) {
    // Keep the newest array: after a drag hands over a new one, every per-shape and per-connector
    // reading would otherwise compare all the shapes again on every store update.
    memo.nodes = nodes;
    return memo.analysis;
  }
  const analysis = analyzeTraffic({ nodes, edges });
  // The nodes the reading was made from are kept with it: names and instance counts come from them.
  memo = { nodes, edges, analysis };
  return analysis;
}

const outages = new WeakMap<TrafficAnalysis, { down: string; whole: boolean; connector: boolean; flows: readonly DraftFlow[]; outage: Outage | null }>();

/** The outage being walked — identity-stable until the graph, the shape or its extent changes.
 *  `null` while nothing is down yet, or once the shape taken down is gone or no longer runs. */
export function outageIn(state: View): Outage | null {
  const { whole, cut } = state.outage;
  // A shape or a connector: whichever is taken down, one reading at a time.
  const down = cut ?? state.outage.down;
  const connector = cut !== null;
  if (!down) return null;
  const analysis = runtimeOf(state);
  if (!analysis || !memo) return null;
  const known = outages.get(analysis);
  // Flows are read against the outage too, and editing one leaves the graph's reading as it was.
  const { flows } = state.document;
  if (known && known.down === down && known.whole === whole && known.connector === connector && known.flows === flows) return known.outage;
  const outage = outageOf(analysis, memo.nodes, state.document.edges, connector ? { id: down, connector } : { id: down, whole }, flows);
  outages.set(analysis, { down, whole, connector, flows, outage });
  return outage;
}

const reviews = new WeakMap<TrafficAnalysis, { flows: readonly DraftFlow[]; review: OutageReview }>();

/**
 * Every shape's outage at once, while a walk is open and nothing is down yet: what the person is
 * choosing between. Each shape is read as the walk would read it, so it is worked out once per
 * graph and kept — never on a drag frame, and not at all once a shape is picked.
 */
export function outageReviewIn(state: View): OutageReview | null {
  if (!state.outage.active || state.outage.down || state.outage.cut) return null;
  const analysis = runtimeOf(state);
  if (!analysis || !memo) return null;
  const { flows } = state.document;
  const known = reviews.get(analysis);
  if (known && known.flows === flows) return known.review;
  const review = outageReview(analysis, memo.nodes, state.document.edges, flows);
  reviews.set(analysis, { flows, review });
  return review;
}

/**
 * How a shape reads during a walk: its `OutageState`, with `lit` for what carries on and `dim` for
 * what takes no part. `null` while no walk is open, or while its shape is still to be picked — the
 * diagram is left exactly as drawn until there is something to say.
 */
export function outageNodeReading(state: View, id: string): Exclude<OutageState, 'unaffected'> | 'lit' | 'dim' | null {
  const outage = outageIn(state);
  if (!outage) return null;
  const reading = outage.nodes.get(id);
  if (reading) return reading === 'unaffected' ? 'lit' : reading;
  return litJunctions(runtimeOf(state)!).has(id) ? 'lit' : 'dim';
}

/** Junctions some route crosses, once per reading — never a resource, but lit with their route. */
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
 * How a connector reads during a walk: what the outage does to it, `cut` when it is the connector
 * taken down, `flow` when it carries on, `none`
 * when it carries no work at all. `null` outside a walk. A string, so only the connectors whose
 * reading changes re-render.
 */
export function outageEdgeOf(state: View, id: string): OutageEdgeState | 'cut' | 'flow' | 'none' | null {
  const outage = outageIn(state);
  if (!outage) return null;
  // The connector taken down is struck through, whatever the walk says of the work it carried.
  if (outage.connector && outage.target === id) return 'cut';
  const changed = outage.edges.get(id);
  if (changed) return changed;
  const edge = runtimeOf(state)!.edges.get(id);
  return !edge || edge.participation === 'none' ? 'none' : 'flow';
}

/**
 * Whether the room has anything an outage could be read from — what decides whether the status bar
 * offers it at all. Early-exit over the connectors with the room's shared node index, so it costs
 * next to nothing on a drag frame.
 */
export function roomMayHaveOutage(state: Pick<EditorStore, 'document'>): boolean {
  const { nodes, edges } = state.document;
  if (edges.length === 0) return false;
  // Remembered per graph, like the reading: a selection, a hover or a drag frame reuses it.
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
