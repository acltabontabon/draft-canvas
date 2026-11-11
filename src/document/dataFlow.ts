/**
 * Reading a diagram as data moving rather than as calls being made: which way data travels along a
 * connector, what feeds a dataset and what it feeds (its lineage), and how often a connector moves
 * data (its cadence). Software diagrams point arrows from the caller; data people point them the
 * way the data goes. A connector's `semantic` already says which — `reads` means a store's data goes
 * to the reader however the line is drawn — so nothing here needs the person to say it twice.
 */

import { categoryOf } from './connectorSemantics';
import { passiveApplies } from './edgeSemantics';
import type { DraftDocument, DraftEdge, DraftNode, EdgeSemantic } from './types';

/** The connector meanings that say data moves — the ones a cadence means something on. */
export const DATA_SEMANTICS: ReadonlySet<EdgeSemantic> = new Set<EdgeSemantic>([
  'reads',
  'writes',
  'readsWrites',
  'query',
  'ingests',
  'transforms',
  'replicates',
  'cdc',
  'syncs',
  'publishes',
  'consumes',
  'deliversTo',
  'fansOut',
  'indexes',
]);

/** Pulling verbs: the doer takes data from the other end. Drawn from the doer (active), data comes
 *  back along the line; drawn from the holder (passive, "read by"), it goes with the arrow. */
const PULLS: ReadonlySet<EdgeSemantic> = new Set<EdgeSemantic>(['reads', 'query', 'searches', 'consumes', 'ingests', 'indexes', 'watches']);
/** Both ways at once. */
const BOTH: ReadonlySet<EdgeSemantic> = new Set<EdgeSemantic>(['readsWrites', 'syncs']);

export type DataDirection = 'forward' | 'backward' | 'both';

/** Which way data travels along `edge` relative to how it is drawn. Anything that isn't a pull
 *  (calls, writes, transforms, publishes…) carries its data with the arrow. */
export function dataDirection(edge: Pick<DraftEdge, 'semantic' | 'source' | 'target'>, nodes: ReadonlyMap<string, DraftNode>): DataDirection {
  const semantic = edge.semantic;
  if (!semantic) return 'forward';
  if (BOTH.has(semantic)) return 'both';
  const source = nodes.get(edge.source);
  const target = nodes.get(edge.target);
  const sourceCategory = source && categoryOf(source);
  const targetCategory = target && categoryOf(target);
  const passive = passiveApplies(semantic, sourceCategory, targetCategory);
  if (PULLS.has(semantic)) return passive ? 'forward' : 'backward';
  // "written by": drawn from the store, the data still goes into it.
  if (semantic === 'writes' && passive) return 'backward';
  return 'forward';
}

/** One connector as data movement: where its data comes from and goes to (twice for `both`). */
function hops(edge: DraftEdge, nodes: ReadonlyMap<string, DraftNode>): { from: string; to: string }[] {
  const direction = dataDirection(edge, nodes);
  const forward = { from: edge.source, to: edge.target };
  const backward = { from: edge.target, to: edge.source };
  return direction === 'both' ? [forward, backward] : direction === 'forward' ? [forward] : [backward];
}

/**
 * Everything `nodeId`'s data comes from and everything it feeds, following data along connectors
 * through any number of shapes — the answer to "where does this number come from, and what breaks
 * if it changes". The shape itself, both sides' shapes, and the connectors between them.
 */
export function lineageOf(doc: Pick<DraftDocument, 'nodes' | 'edges'>, nodeId: string): { nodeIds: string[]; edgeIds: string[] } {
  const nodes = new Map(doc.nodes.map((node) => [node.id, node] as const));
  const into = new Map<string, { edge: string; from: string }[]>();
  const outOf = new Map<string, { edge: string; to: string }[]>();
  for (const edge of doc.edges) {
    if (edge.source === edge.target) continue;
    for (const hop of hops(edge, nodes)) {
      (into.get(hop.to) ?? into.set(hop.to, []).get(hop.to)!).push({ edge: edge.id, from: hop.from });
      (outOf.get(hop.from) ?? outOf.set(hop.from, []).get(hop.from)!).push({ edge: edge.id, to: hop.to });
    }
  }
  const nodeIds = new Set([nodeId]);
  const edgeIds = new Set<string>();
  const walk = (start: string, step: (id: string) => { edge: string; next: string }[]) => {
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length > 0) {
      const at = queue.shift()!;
      for (const { edge, next } of step(at)) {
        edgeIds.add(edge);
        nodeIds.add(next);
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
  };
  walk(nodeId, (id) => (into.get(id) ?? []).map(({ edge, from }) => ({ edge, next: from })));
  walk(nodeId, (id) => (outOf.get(id) ?? []).map(({ edge, to }) => ({ edge, next: to })));
  return { nodeIds: [...nodeIds], edgeIds: [...edgeIds] };
}

/** How often a connector moves its data, as offered in the connector panel. The field itself is
 *  free text ("every 15 min", "daily 02:00"); these are the common answers. */
export const CADENCE_PRESETS = ['streaming', 'hourly', 'daily', 'weekly', 'on demand'] as const;
