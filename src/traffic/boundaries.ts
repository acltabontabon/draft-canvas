import type { DraftNode } from '../document/types';
import type { TrafficAnalysis } from './types';

/** Membership, not line geometry: a junction can bend a route without crossing a boundary.
 * One normalized interaction stays one route even when it crosses several nested boundaries. */
export function boundaryCrossings(analysis: TrafficAnalysis, nodes: readonly DraftNode[], selection: { boundaryId?: string; nodeId?: string; edgeId?: string }) {
  const index = new Map(nodes.map((node) => [node.id, node]));
  const ancestors = new Map<string, Set<string>>();
  const parents = (id: string) => {
    const known = ancestors.get(id);
    if (known) return known;
    const result = new Set<string>();
    const seen = new Set([id]);
    let parent = index.get(id)?.parentId;
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      const node = index.get(parent);
      if (!node || node.type !== 'group') break;
      if (node.boundaryPreset !== 'group') result.add(parent);
      parent = node.parentId;
    }
    ancestors.set(id, result);
    return result;
  };
  return analysis.interactions.flatMap((item) => {
    if (!item.workload) return [];
    if (selection.edgeId && !item.edgeIds.includes(selection.edgeId)) return [];
    if (selection.nodeId && item.from !== selection.nodeId && item.to !== selection.nodeId) return [];
    const from = parents(item.from);
    const to = parents(item.to);
    const crossed = [...new Set([...from, ...to])].filter((id) => from.has(id) !== to.has(id));
    if (!crossed.length || selection.boundaryId && !crossed.includes(selection.boundaryId)) return [];
    const direction = selection.boundaryId ? to.has(selection.boundaryId) ? 'Incoming' : 'Outgoing' : undefined;
    const wait = item.sync ? 'Waits for response (as drawn)'
      : item.class === 'publish' || item.class === 'deliver' ? 'Message handoff · wait unspecified' : 'No synchronous wait drawn';
    return [{ id: item.id, from: item.from, to: item.to, crossed, direction,
      wait: `${item.certainty === 'possible' ? 'If taken · ' : ''}${wait}` }];
  });
}
