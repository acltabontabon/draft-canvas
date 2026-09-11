/**
 * Builds a deterministic, realistic benchmark diagram by tiling real starters — the same
 * `buildStarter`/`categoryOf`/`inferRelationship` pipeline the app itself uses, rather than
 * inventing fake clusters. See `benchmark/workloads/index.ts` for the tile order and
 * `benchmark/workloads/layout.ts` for placement.
 */

import { buildStarter, starterById, starterSize } from '../../src/starters';
import { categoryOf, inferRelationship } from '../../src/document/connectorSemantics';
import { createDocument, createEdge } from '../../src/document/factory';
import type { DraftDocument, DraftEdge, DraftFlow, DraftNode } from '../../src/document/types';
import { nextTileOrigin } from './layout';
import { TILE_ORDER, type WorkloadSpec } from './index';

const ROW_CAPACITY = 3;
const EXIT_CATEGORIES = new Set(['database', 'queue', 'topic', 'cache']);

/**
 * Once the running total is already close to `spec.targetNodes`, blindly taking
 * `TILE_ORDER[i % TILE_ORDER.length]` next can pick a tile that overshoots the target by a lot —
 * and the post-loop trim then has to hack a disproportionate number of nodes (and their internal
 * edges) off that one tile's tail to land back on the target.
 *
 * 0.8 is empirical, not a round-number guess, and it is *not* simply "the threshold that makes the
 * final node count closest to the target" — that turned out to be the wrong thing to optimize for.
 * Minimizing node-count overshoot alone (tried first, at thresholds like 0.1) actually produced
 * *fewer* edges than doing nothing (18/65 for small/medium vs. an unpatched 20/77), because it
 * changes *which* tiles end up in the document, and this catalog's five starters have quite
 * different edge density (event-driven: 10 edges/11 nodes; cqrs: 8 edges/13 nodes) — chasing an
 * exact node-count fit tends to prefer whichever tile size divides the remaining budget evenly,
 * not the one with the most edges, and a lightly-trimmed low-density tile can easily lose to a
 * heavily-trimmed high-density one.
 *
 * So the threshold here was chosen by directly sweeping the real generator (same
 * pickEntry/pickExit/trim/filter pipeline as below) across thresholds 0-1 and reading off actual
 * edge counts, not by reasoning about node counts in the abstract. Edge count rises step-wise as
 * the threshold increases (more of the loop runs under plain cycling, so more whole, dense tiles
 * get committed before the final tile is chosen carefully) and plateaus at 21 edges for `small` /
 * 79 for `medium` across roughly [0.79, 0.91], then drops back to the unpatched 20/77 once the
 * threshold is high enough that the smart pick almost never fires. This is a real, if modest,
 * improvement over the unpatched baseline — not a fix that closes the gap to the target ranges
 * (see the regen report for why: this tile catalog is simply too coarse, at 10-13 nodes per
 * starter, for tile *selection* alone to hit a 25-node target precisely without more starters or a
 * smaller filler tile).
 *
 * Phase B re-swept the same pipeline at the LARGE/STRESS/EXTREME target sizes (225/500/1000) before
 * assuming 0.8 still applied, and it doesn't cleanly: at these sizes edge count keeps climbing
 * (190→192→425→431→834→863 for large/stress/extreme as the threshold goes 0.8→0.9→...→1.0) instead
 * of plateauing early, because more of a 500-1000-node document is built under the smart pick, and
 * the smart pick optimizes node-count fit, not edge density (see above) — so raising the threshold
 * shifts more of the document to plain cycling, which is denser. 0.9 was picked as the best
 * available compromise: it still sits inside the documented [0.79, 0.91] small/medium plateau (21/
 * 79 edges, unchanged), it already captures the *entire* large plateau (192 edges, same as 0.95 and
 * 1.0), and it captures most of the stress/extreme gain (425/853 vs. 431/863 at threshold 1.0 — a
 * ~1.5% difference not worth breaking the small/medium plateau for). Pushing past 0.91 drops small/
 * medium back to the unpatched 20/77, so 0.9 is the ceiling that doesn't regress the sizes Phase A
 * already tuned for.
 */
const TAIL_SELECTION_THRESHOLD = 0.9;

/**
 * Deterministically pick the best tile to append next, once close to the target: prefer whichever
 * `TILE_ORDER` entry brings the running total nearest `spec.targetNodes` (smallest overshoot if it
 * reaches/exceeds the target, otherwise smallest shortfall), so the tile that still needs trimming
 * afterward is only ever a node or two over rather than 10+. Ties keep the existing cycling order
 * (i.e. the candidate that would have been picked without this optimization wins ties), for
 * determinism.
 */
function pickNextTileIndex(currentNodeCount: number, targetNodes: number, cycleStart: number): number {
  let bestIndex = cycleStart % TILE_ORDER.length;
  let bestDistance = Infinity;

  for (let offset = 0; offset < TILE_ORDER.length; offset += 1) {
    const index = (cycleStart + offset) % TILE_ORDER.length;
    const candidate = starterById(TILE_ORDER[index]!)!;
    const prospectiveTotal = currentNodeCount + candidate.nodes.length;
    const distance = Math.abs(prospectiveTotal - targetNodes);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }

  return bestIndex;
}

function pickEntry(tileNodes: DraftNode[]): DraftNode {
  const gateway = tileNodes.find((node) => categoryOf(node) === 'gateway');
  if (gateway) return gateway;
  const service = tileNodes.find((node) => categoryOf(node) === 'service');
  return service ?? tileNodes[0]!;
}

function pickExit(previousTileNodes: DraftNode[]): DraftNode {
  for (let i = previousTileNodes.length - 1; i >= 0; i -= 1) {
    const node = previousTileNodes[i]!;
    if (EXIT_CATEGORIES.has(categoryOf(node))) return node;
  }
  return previousTileNodes[previousTileNodes.length - 1]!;
}

/**
 * Lower-level entry point: tiles starters until `targetNodes` is reached/exceeded, then trims and
 * repairs, with no dependency on a named `WorkloadSpec` — used both by `buildWorkloadDocument`
 * (below) and directly by the scaling benchmark, which needs documents at arbitrary node counts
 * (25/50/100/250/500/1000) that don't all correspond to a named workload.
 */
export function buildDocumentForNodeCount(targetNodes: number, label = `${targetNodes} nodes`): DraftDocument {
  const doc = createDocument(`Benchmark — ${label}`);

  const nodes: DraftNode[] = [];
  const edges: DraftEdge[] = [];
  const flows: DraftFlow[] = [];

  let previousTileNodes: DraftNode[] | undefined;
  let i = 0;
  while (nodes.length < targetNodes) {
    const nearTarget = nodes.length >= targetNodes * TAIL_SELECTION_THRESHOLD;
    const tileIndex = nearTarget ? pickNextTileIndex(nodes.length, targetNodes, i) : i % TILE_ORDER.length;
    const starterId = TILE_ORDER[tileIndex]!;
    const starter = starterById(starterId)!;
    const size = starterSize(starter);
    const origin = nextTileOrigin(i, size, ROW_CAPACITY);
    const built = buildStarter(starter, origin);

    if (previousTileNodes && previousTileNodes.length > 0 && built.nodes.length > 0) {
      const entry = pickEntry(built.nodes);
      const exit = pickExit(previousTileNodes);
      const relationship = inferRelationship(exit, entry);
      const crossTileEdge = createEdge({
        source: exit.id,
        target: entry.id,
        semantic: relationship?.semantic,
        kind: relationship?.kind,
        async: relationship?.async,
        semanticsOrigin: relationship?.semantic ? 'inferred' : undefined,
      });
      edges.push(crossTileEdge);
    }

    nodes.push(...built.nodes);
    edges.push(...built.edges);
    flows.push(...built.flows);
    previousTileNodes = built.nodes;
    i += 1;
  }

  let trimmedNodes = nodes;
  if (nodes.length > targetNodes) {
    const overshoot = nodes.length - targetNodes;
    trimmedNodes = nodes.slice(0, nodes.length - overshoot);
  }

  // Repair pass: a trimmed-out boundary must never leave orphaned children pointing at nothing.
  const remainingNodeIds = new Set(trimmedNodes.map((node) => node.id));
  const repairedNodes = trimmedNodes.map((node) => {
    if (node.parentId && !remainingNodeIds.has(node.parentId)) {
      const { parentId: _parentId, ...rest } = node;
      return rest as DraftNode;
    }
    return node;
  });

  const filteredEdges = edges.filter(
    (edge) => remainingNodeIds.has(edge.source) && remainingNodeIds.has(edge.target),
  );
  const remainingEdgeIds = new Set(filteredEdges.map((edge) => edge.id));

  const filteredFlows = flows
    .map((flow) => ({ ...flow, steps: flow.steps.filter((step) => step.edgeId && remainingEdgeIds.has(step.edgeId)) }))
    .filter((flow) => flow.steps.length > 0);

  return { ...doc, nodes: repairedNodes, edges: filteredEdges, flows: filteredFlows };
}

export function buildWorkloadDocument(spec: WorkloadSpec): DraftDocument {
  return buildDocumentForNodeCount(spec.targetNodes, spec.label);
}
