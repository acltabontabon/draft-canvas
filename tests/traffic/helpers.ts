import { createEdge, createNode } from '../../src/document/factory';
import type { CreateEdgeInput, CreateNodeInput } from '../../src/document/factory';
import type { DraftEdge, DraftNode } from '../../src/document/types';
import type { TrafficAnalysis, TrafficInsight, TrafficInteraction } from '../../src/traffic';

export function node(
  id: string,
  type: DraftNode['type'],
  options: Omit<Partial<CreateNodeInput>, 'id' | 'type' | 'x' | 'y'> = {},
): DraftNode {
  return createNode({ type, id, x: 0, y: 0, ...options });
}

export function edge(
  id: string,
  source: string,
  target: string,
  options: Omit<Partial<CreateEdgeInput>, 'id' | 'source' | 'target'> = {},
): DraftEdge {
  return createEdge({ id, source, target, ...options });
}

export function interaction(
  analysis: TrafficAnalysis,
  from: string,
  to: string,
  trafficClass?: TrafficInteraction['class'],
): TrafficInteraction {
  const found = analysis.interactions.find((value) => value.from === from && value.to === to && (trafficClass === undefined || value.class === trafficClass));
  if (found === undefined) throw new Error(`Missing traffic interaction ${from}>${to}${trafficClass ? `>${trafficClass}` : ''}`);
  return found;
}

export function insight(analysis: TrafficAnalysis, kind: TrafficInsight['kind']): TrafficInsight {
  const found = analysis.insights.find((value) => value.kind === kind);
  if (found === undefined) throw new Error(`Missing ${kind} insight`);
  return found;
}

/** Compare only fields whose ordering is explicitly independent of input order. */
export function orderIndependentShape(analysis: TrafficAnalysis): unknown {
  return {
    status: analysis.status,
    entries: [...analysis.entries].sort(),
    hotspots: analysis.hotspots,
    nodes: [...analysis.nodes.values()]
      .map((value) => ({ id: value.id, paths: value.paths, tier: value.tier, rank: value.rank, isEntry: value.isEntry, inLoop: value.inLoop }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    interactions: analysis.interactions
      .map((value) => ({ id: value.id, certainty: value.certainty, uncertainty: value.uncertainty, sync: value.sync, inferred: value.inferred, loop: value.loop, paths: value.paths }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    insights: analysis.insights.map((value) => ({ id: value.id, text: value.text })).sort((a, b) => a.id.localeCompare(b.id)),
    truncated: analysis.truncated,
  };
}
