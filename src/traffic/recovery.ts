import type { DraftEdge, DraftNode } from '../document/types';
import type { TrafficAnalysis, TrafficInteraction } from './types';
import { workPerArrival } from './work';

export const MAX_REPLAY_MESSAGES = 1_000_000;

/** Only explicitly drawn compensation and DLQ replay paths qualify. A generic failure or fallback
 * is not necessarily a compensating action, and an inbound dead-letter route is not a replay. */
export function recoveryPlan(analysis: TrafficAnalysis, nodes: readonly DraftNode[], edges: readonly DraftEdge[], id: string) {
  const node = nodes.find((item) => item.id === id);
  if (!node) return null;
  const drawn = new Map(edges.map((edge) => [edge.id, edge]));
  const dlq = node.deliveryRole === 'dead-letter';
  const compensations = analysis.interactions.filter((item) => item.class === 'failure' && item.edgeIds.some((edgeId) => drawn.get(edgeId)?.semantic === 'compensates'));
  const seeds = analysis.interactions.filter((item) => item.from === id && (dlq
    ? !!item.workload
    : compensations.includes(item)));
  if (!dlq && seeds.length === 0) return null;
  // A synthetic starting point invokes just the recovery routes, never the initiating service's
  // ordinary outgoing calls. Normal work from recovery destinations then follows the drawn graph.
  let start = `recovery:${id}`;
  while (analysis.nodes.has(start)) start += ':';
  const interactions: TrafficInteraction[] = [
    ...analysis.interactions.filter((item) => !!item.workload),
    ...(!dlq ? compensations.map((item): TrafficInteraction => ({ ...item, class: 'request', workload: 'request', certainty: 'possible' })) : []),
    ...seeds.map((item): TrafficInteraction => ({
      ...item,
      from: start,
      class: dlq ? item.class : 'request',
      workload: dlq ? item.workload : 'request',
      // We cannot know which original transactions completed, hence which compensations apply.
      certainty: dlq ? item.certainty : 'possible',
      loop: false,
    })),
  ];
  const outgoing = new Map<string, string[]>();
  for (const item of interactions) {
    const list = outgoing.get(item.from) ?? [];
    list.push(item.to);
    outgoing.set(item.from, list);
  }
  const reached = new Set([start]);
  const pending = [start];
  for (let index = 0; index < pending.length; index += 1) {
    for (const to of outgoing.get(pending[index]!) ?? []) {
      if (reached.has(to)) continue;
      reached.add(to);
      pending.push(to);
    }
  }
  const shared = pending.filter((at) => at !== start && (analysis.nodes.get(at)?.paths.possible ?? 0) > 0);
  return { kind: dlq ? 'replay' as const : 'compensation' as const, start, interactions, shared, targets: [...new Set(seeds.map((item) => item.to))], missing: seeds.length === 0 };
}

export function recoveryWork(analysis: TrafficAnalysis, plan: NonNullable<ReturnType<typeof recoveryPlan>>, messages = 1) {
  if (!Number.isSafeInteger(messages) || messages < 1 || messages > MAX_REPLAY_MESSAGES) return null;
  if (plan.missing) return { items: ['No replay path drawn.'], uncertain: true, unknown: true };
  return workPerArrival({ ...analysis, interactions: plan.interactions }, plan.start, plan.kind === 'replay' ? messages : 1);
}

/** Per-shape batch arrivals for the temporary canvas overlay. Unknown totals never become badges. */
export function recoveryArrivals(analysis: TrafficAnalysis, plan: NonNullable<ReturnType<typeof recoveryPlan>>, messages: number) {
  const work = recoveryWork(analysis, plan, messages);
  if (!work || work.unknown) return new Map<string, { definite: number; possible: number }>();
  const outgoing = new Map<string, TrafficInteraction[]>();
  for (const item of plan.interactions) {
    const list = outgoing.get(item.from) ?? [];
    list.push(item);
    outgoing.set(item.from, list);
  }
  const reached = new Set([plan.start]);
  const pending = [plan.start];
  for (let i = 0; i < pending.length; i += 1) for (const item of outgoing.get(pending[i]!) ?? []) {
    if (!reached.has(item.to)) { reached.add(item.to); pending.push(item.to); }
  }
  const indegree = new Map(pending.map((id) => [id, 0]));
  for (const id of pending) for (const item of outgoing.get(id) ?? []) indegree.set(item.to, indegree.get(item.to)! + 1);
  const ready = pending.filter((id) => indegree.get(id) === 0);
  const counts = new Map([[plan.start, { definite: messages, possible: messages }]]);
  for (let i = 0; i < ready.length; i += 1) {
    const id = ready[i]!;
    const count = counts.get(id)!;
    for (const item of outgoing.get(id) ?? []) {
      const next = counts.get(item.to) ?? { definite: 0, possible: 0 };
      next.definite += item.certainty === 'possible' ? 0 : count.definite;
      next.possible += count.possible;
      counts.set(item.to, next);
      indegree.set(item.to, indegree.get(item.to)! - 1);
      if (indegree.get(item.to) === 0) ready.push(item.to);
    }
  }
  counts.delete(plan.start);
  return counts;
}
