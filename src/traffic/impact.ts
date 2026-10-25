import type { TrafficAnalysis, TrafficInteraction } from './types';

/**
 * What depends on one element, and what it depends on — the questions someone asks of a shape
 * before changing, scaling or taking it down: "if this is slow, who waits?", "if it's down, which
 * journeys stop?", "what does it wait on itself?", "what is safely behind a queue?".
 *
 * Waiting follows synchronous calls and data operations — a caller holds its request open for both
 * — and stops at an asynchronous hand-off (publishing, delivery), which is exactly what a queue or
 * topic buys. Pure topology: nothing here says how long anyone waits.
 */
export interface TrafficImpact {
  /** Runtime elements whose requests wait on this one, nearest first. */
  waiting: string[];
  /** Where those waits start — the entry points (people, devices, schedulers, root services). */
  journeys: string[];
  /** What this one waits on in turn, nearest first. */
  dependsOn: string[];
  /** What it may wait on, across a split, route or condition whose share isn't drawn. */
  mayDependOn: string[];
  /** Downstream of it, but behind an asynchronous hand-off: they can lag or fail without holding it up. */
  decoupled: string[];
}

/** Whoever makes this interaction holds its request open until it returns. */
export function waitsOn(interaction: TrafficInteraction): boolean {
  if (interaction.loop) return false;
  return (interaction.class === 'request' || interaction.class === 'data') && interaction.sync;
}

export function impactOf(analysis: TrafficAnalysis, id: string): TrafficImpact {
  const callers = new Map<string, string[]>();
  const callees = new Map<string, string[]>();
  const async = new Map<string, string[]>();
  const maybe = new Map<string, string[]>();
  const mayCall = new Map<string, string[]>();
  for (const interaction of analysis.interactions) {
    if (interaction.paths.possible === 0) continue;
    // Only what certainly happens is waited on; one of several routes is a "may".
    if (waitsOn(interaction) && interaction.certainty === 'possible') {
      push(maybe, interaction.from, interaction.to);
      push(mayCall, interaction.to, interaction.from);
      continue;
    }
    const bucket = waitsOn(interaction) ? callees : interaction.class === 'publish' || interaction.class === 'deliver' ? async : null;
    if (!bucket) continue;
    push(bucket, interaction.from, interaction.to);
    if (bucket === callees) push(callers, interaction.to, interaction.from);
  }
  const entries = new Set(analysis.entries);
  const upstream = walk(callers, id);
  const downstream = walk(callees, id);

  // Behind a hand-off: anything reached from this node, or from what it waits on, through messaging.
  const decoupled: string[] = [];
  const seen = new Set([id, ...downstream]);
  const pending = [id, ...downstream].flatMap((from) => async.get(from) ?? []);
  for (let head = 0; head < pending.length; head += 1) {
    const at = pending[head]!;
    if (seen.has(at)) continue;
    seen.add(at);
    if (analysis.nodes.get(at)?.role !== 'messaging') decoupled.push(at);
    for (const next of [...(async.get(at) ?? []), ...(callees.get(at) ?? [])]) pending.push(next);
  }

  // A journey that only may reach it (one of a gateway's routes) still stalls when it does.
  const either = new Map(callers);
  for (const [to, froms] of mayCall) for (const from of froms) push(either, to, from);
  const journeys = [...walk(either, id), id].filter((at) => entries.has(at));
  const certain = new Set(downstream);
  const mayDependOn = [...new Set([id, ...downstream].flatMap((at) => maybe.get(at) ?? []))].filter((at) => !certain.has(at) && at !== id);
  return {
    waiting: upstream.filter((at) => analysis.nodes.get(at)?.role !== 'origin'),
    journeys,
    dependsOn: downstream,
    mayDependOn,
    decoupled,
  };
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (!list) map.set(key, [value]);
  else if (!list.includes(value)) list.push(value);
}

/** Breadth first, so nearest comes first and a loop ends the walk. */
function walk(next: Map<string, string[]>, start: string): string[] {
  const seen = new Set([start]);
  const order: string[] = [];
  const pending = [...(next.get(start) ?? [])];
  for (let head = 0; head < pending.length; head += 1) {
    const at = pending[head]!;
    if (seen.has(at)) continue;
    seen.add(at);
    order.push(at);
    pending.push(...(next.get(at) ?? []));
  }
  return order;
}
