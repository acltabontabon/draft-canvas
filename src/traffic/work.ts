import { PATH_CAP, type PathCount, type TrafficAnalysis, type TrafficInteraction } from './types';
import { scenarioRateLabel, trafficScenario } from './scenario';

const UNITS = { request: 'calls/min', message: 'messages/min', data: 'data ops/min' };

/** Keep each incoming interaction visible, including different kinds of work from one source. */
export function rateBreakdown(analysis: TrafficAnalysis, id: string) {
  const rates = trafficScenario(analysis);
  return analysis.interactions
    .filter((item) => item.to === id && item.workload && (item.paths.possible > 0 || item.loop))
    .map((item) => ({
      from: item.from,
      rate: analysis.truncated || item.loop || rates.get(item.from) === 'Rate unknown'
        ? 'Rate unknown' : scenarioRateLabel(item.paths, UNITS[item.workload!]),
    }));
}

type WorkKind = 'request' | 'data' | 'publish' | 'deliver';
const KINDS: WorkKind[] = ['request', 'data', 'publish', 'deliver'];
const NOUNS: Record<WorkKind, [string, string]> = {
  request: ['downstream call', 'downstream calls'],
  data: ['data operation', 'data operations'],
  publish: ['message published', 'messages published'],
  deliver: ['message delivery', 'message deliveries'],
};

/** One arrival at the selected shape, independent of RPM and other entry points. Propagate counts
 * in topological order so converging work continues downstream once per arrival, not once per node.
 * Reachable cycles and bounded analyses cannot establish a finite total. */
export function workPerArrival(analysis: TrafficAnalysis, id: string, arrivals = 1): { items: string[]; uncertain: boolean; unknown: boolean } {
  const outgoing = new Map<string, TrafficInteraction[]>();
  for (const item of analysis.interactions) {
    if (!item.workload) continue;
    const list = outgoing.get(item.from) ?? [];
    list.push(item);
    outgoing.set(item.from, list);
  }
  const reached = new Set([id]);
  const pending = [id];
  for (let index = 0; index < pending.length; index += 1) {
    for (const item of outgoing.get(pending[index]!) ?? []) {
      if (reached.has(item.to)) continue;
      reached.add(item.to);
      pending.push(item.to);
    }
  }
  const unknown = { items: ['Work unknown — loop repeats or analysis limits.'], uncertain: true, unknown: true };
  if (analysis.truncated) return unknown;
  const indegree = new Map(pending.map((at) => [at, 0]));
  for (const at of pending) for (const item of outgoing.get(at) ?? []) indegree.set(item.to, indegree.get(item.to)! + 1);
  const ready = pending.filter((at) => indegree.get(at) === 0);
  const paths = new Map<string, PathCount>([[id, { definite: 1, possible: 1 }]]);
  const totals = new Map(KINDS.map((kind) => [kind, { definite: 0, possible: 0 }]));
  let uncertain = false;
  for (let index = 0; index < ready.length; index += 1) {
    const at = ready[index]!;
    const count = paths.get(at) ?? { definite: 0, possible: 0 };
    for (const item of outgoing.get(at) ?? []) {
      const contribution = { definite: item.certainty === 'possible' ? 0 : count.definite, possible: count.possible };
      uncertain ||= contribution.definite !== contribution.possible;
      const destination = paths.get(item.to) ?? { definite: 0, possible: 0 };
      for (const value of [totals.get(item.class as WorkKind)!, destination]) {
        value.definite += contribution.definite;
        value.possible += contribution.possible;
        if (value.possible >= PATH_CAP) return unknown;
      }
      paths.set(item.to, destination);
      indegree.set(item.to, indegree.get(item.to)! - 1);
      if (indegree.get(item.to) === 0) ready.push(item.to);
    }
  }
  if (ready.length !== reached.size) return unknown;
  const items = KINDS.flatMap((kind) => {
    const count = totals.get(kind)!;
    if (count.possible === 0) return [];
    const amount = count.definite === count.possible ? (count.possible * arrivals).toLocaleString('en-US') : `${(count.definite * arrivals).toLocaleString('en-US')}–${(count.possible * arrivals).toLocaleString('en-US')}`;
    return [`${amount} ${NOUNS[kind][count.possible * arrivals === 1 ? 0 : 1]}`];
  });
  return { items: items.length ? items : ['No downstream work drawn.'], uncertain, unknown: false };
}
