import type { DraftEdge } from '../document/types';
import { scenarioRateLabel, trafficScenario } from './scenario';
import type { PathCount, TrafficAnalysis } from './types';

/** Normalized routes may merge parallel connectors. Keep mixed/unspecified semantics combined
 * rather than inventing a read/write split or counting a merged route twice. */
export function databaseWork(analysis: TrafficAnalysis, edges: readonly DraftEdge[], id: string) {
  if (analysis.nodes.get(id)?.role !== 'data') return null;
  const rates = trafficScenario(analysis);
  if (rates.get(id) === 'Rate unknown') return ['Database work unknown — loop repeats or analysis limits.'];
  const drawn = new Map(edges.map((edge) => [edge.id, edge]));
  const totals = new Map<string, PathCount>();
  for (const item of analysis.interactions) {
    if (item.to !== id || item.class !== 'data' || item.paths.possible === 0) continue;
    const kinds = new Set(item.edgeIds.map((edgeId) => {
      const semantic = drawn.get(edgeId)?.semantic;
      return semantic === 'reads' || semantic === 'query' || semantic === 'searches' ? 'reads/min'
        : semantic === 'writes' || semantic === 'indexes' || semantic === 'invalidates' ? 'writes/min'
          : 'combined / unspecified ops/min';
    }));
    const kind = kinds.size === 1 ? [...kinds][0]! : 'combined / unspecified ops/min';
    const total = totals.get(kind) ?? { definite: 0, possible: 0 };
    total.definite += item.paths.definite;
    total.possible += item.paths.possible;
    totals.set(kind, total);
  }
  return ['reads/min', 'writes/min', 'combined / unspecified ops/min'].flatMap((kind) => {
    const paths = totals.get(kind);
    return paths ? [scenarioRateLabel(paths, kind)] : [];
  });
}
