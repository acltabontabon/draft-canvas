import { categoryOf } from '../document/connectorSemantics';
import { displayNameFor } from '../document/factory';
import type { DraftNode } from '../document/types';
import type { AnalysisContext } from './analyze';
import { compareText } from './graph';
import { MAX_INSIGHTS, type TrafficAnalysis, type TrafficInsight, type TrafficInsightKind, type TrafficInteraction } from './types';

/**
 * Deterministic observations about the analysis, each one sentence about named elements.
 *
 * The wording is held to what the diagram establishes: where drawn paths meet, what a topology
 * implies (a queue decouples, a topic copies), and — just as plainly — what it leaves unsaid. Never
 * a rate, a latency, a utilisation or a verdict like "bottleneck": none of that is in a diagram.
 */

const KIND_ORDER: TrafficInsightKind[] = [
  'convergence',
  'shared-dependency',
  'external-on-sync',
  'dead-end',
  'gateway-bypass',
  'hub',
  'amplification',
  'fan-out',
  'sync-chain',
  'async-buffer',
  'message-distribution',
  'competing-consumers',
  'routed-split',
  'retry-amplification',
  'ambiguous-split',
  'conditional',
  'loop',
  'scheduler',
  'external',
  'unsupported-hop',
  'undirected',
  'conflicting-semantics',
  'dangling-junction',
  'not-counted',
  'no-concentration',
];

const SEVERITY_ORDER: Record<TrafficInsight['severity'], number> = { notable: 0, info: 1, unknown: 2 };

/** Candidates for "every path passes through here" checked at most — each costs a graph walk. */
const MAX_HUB_CANDIDATES = 50;

const NUMBER_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];

type Seed = Omit<TrafficInsight, 'id'>;

function joinNames(values: string[]): string {
  if (values.length <= 1) return values[0] ?? '';
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  if (values.length === 3) return `${values[0]}, ${values[1]} and ${values[2]}`;
  return `${values.slice(0, 3).join(', ')} and ${values.length - 3} more`;
}

function plural(count: number, noun: string, many = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : many}`;
}

function idFor(seed: Seed): string {
  return `${seed.kind}:${[...seed.nodeIds].sort(compareText).join(',')}:${[...seed.edgeIds].sort(compareText).join(',')}`;
}

/** What a shape that isn't a runtime resource is, in the words someone would use for it. */
function excludedNoun(node: DraftNode): string {
  if (node.type === 'component') return node.componentKind === 'port' ? 'a port' : node.componentKind === 'adapter' ? 'an adapter' : 'a component';
  if (node.type === 'database') return 'a table';
  return 'a shape';
}

export function buildInsights(analysis: TrafficAnalysis, context: AnalysisContext): TrafficInsight[] {
  const { graph, incoming, outgoing } = context;
  const nodes = graph.nodes;
  const name = (id: string) => {
    const node = nodes.get(id);
    return node ? displayNameFor(node) : 'Untitled';
  };
  const names = (ids: string[]) => joinNames(ids.map(name));
  const seeds: Seed[] = [];
  const add = (seed: Seed) => seeds.push(seed);
  const inOf = (id: string): TrafficInteraction[] => incoming.get(id) ?? [];
  const outOf = (id: string): TrafficInteraction[] => outgoing.get(id) ?? [];

  // What the graph could not read.
  for (const diagnostic of graph.diagnostics) {
    const [first, second, ...rest] = diagnostic.nodeIds;
    if (first === undefined) continue;
    const base = { severity: 'unknown' as const, basis: 'structural' as const, nodeIds: diagnostic.nodeIds, edgeIds: diagnostic.edgeIds };
    if (diagnostic.kind === 'undirected') {
      add({ ...base, kind: 'undirected', text: `The line between ${name(first)} and ${name(second!)} has no direction, so it isn't read as traffic.` });
    } else if (diagnostic.kind === 'unsupported-hop') {
      const middle = nodes.get(first)!;
      add({
        ...base,
        kind: 'unsupported-hop',
        note: 'traffic stops here',
        focus: [first],
        nodeIds: [second!, first, rest[0]!],
        text: `${name(second!)} reaches ${name(rest[0]!)} only through ${name(first)}, ${excludedNoun(middle)} — connect the runtime services directly, or look inside.`,
      });
    } else if (diagnostic.kind === 'ambiguous-split') {
      const count = rest.length;
      const amount = count < NUMBER_WORDS.length ? NUMBER_WORDS[count]! : String(count);
      add({
        ...base,
        kind: 'ambiguous-split',
        note: 'which way?',
        focus: [second!],
        text: `${amount} possible paths leave ${name(second!)} after ${name(first)}, to ${names(rest)}, with nothing saying which — label each branch with its condition so readers (and this count) know how it splits. Until then each is only possibly reached.`,
      });
    } else if (diagnostic.kind === 'conflicting-semantics') {
      add({
        ...base,
        kind: 'conflicting-semantics',
        text: `The connectors through ${name(first)} between ${name(second!)} and ${name(rest[0]!)} say different things, so that route isn't counted.`,
      });
    } else {
      add({
        ...base,
        kind: 'dangling-junction',
        text:
          second === undefined
            ? `Nothing leads into ${name(first)}, so what leaves it isn't counted.`
            : `Traffic from ${name(first)} ends at ${name(second)} — nothing leads on from it.`,
      });
    }
  }

  // Each observation below leads with what it means for the system — who is affected, what is
  // coupled, what multiplies — and then the evidence for it, so it says something the picture alone
  // doesn't. None of them puts a number on time or load.
  const drawn = new Map(graph.edgeList.map((edge) => [edge.id, edge]));
  const journeysOf = (id: string) => analysis.nodes.get(id)?.entries ?? [];
  const isEntryNode = (id: string) => analysis.nodes.get(id)?.isEntry === true;
  const hasFallback = (id: string) => analysis.interactions.some((interaction) => interaction.from === id && interaction.class === 'failure');
  const unitOf = (id: string) => {
    const group = analysis.nodes.get(id)?.group;
    return group === 'data' ? ['operation', 'operations'] : group === 'messaging' ? ['message', 'messages'] : ['call', 'calls'];
  };
  /** What a service does to a store, in the words of the connectors that say so. */
  const verbOf = (interaction: TrafficInteraction): 'reads' | 'writes' | 'reads and writes' => {
    const semantics = new Set(interaction.edgeIds.map((id) => drawn.get(id)?.semantic));
    if (semantics.has('readsWrites') || (semantics.has('writes') && semantics.has('reads'))) return 'reads and writes';
    if (semantics.has('writes') || semantics.has('indexes') || semantics.has('invalidates') || semantics.has('ingests')) return 'writes';
    return 'reads';
  };

  // Blast radius: elements on several journeys at once, said once per set of journeys they share.
  const onJourneys = new Map<string, string[]>();
  for (const node of analysis.nodes.values()) {
    if (node.group !== 'services' || node.sources.length < 2 || categoryOf(nodes.get(node.id)!) === 'external') continue;
    const journeys = journeysOf(node.id);
    if (journeys.length < 2) {
      // "More than once" only when both routes certainly happen — one of a gateway's routes or a
      // split's branches is a different request, not the same one twice.
      if (node.paths.definite < 2) continue;
      add({
        kind: 'convergence',
        note: `reached ${node.sources.length} ways`,
        focus: [node.id],
        severity: 'notable',
        basis: 'modeled',
        nodeIds: [node.id, ...node.sources],
        edgeIds: [],
        text: `${name(node.id)} is reached by ${node.sources.length} routes on the same journey — through ${names(node.sources)} — so one request from ${names(journeys)} can call it more than once.`,
      });
      continue;
    }
    const key = journeys.join('|');
    onJourneys.set(key, [...(onJourneys.get(key) ?? []), node.id]);
  }
  for (const [key, ids] of onJourneys) {
    const journeys = key.split('|');
    const one = ids.length === 1;
    add({
      kind: 'convergence',
      note: `${journeys.length === analysis.entries.length ? 'on every journey' : `on ${journeys.length} journeys`} — protect first`,
      focus: ids,
      severity: 'notable',
      basis: 'modeled',
      nodeIds: [...ids, ...journeys],
      edgeIds: [],
      text: `${names(ids)} ${one ? 'is' : 'are each'} on ${journeys.length} separate journeys — ${names(journeys)}. A slowdown or outage there reaches all of them at once, so ${one ? 'it is the place' : 'they are the places'} to protect first: redundancy and timeouts pay off most there.`,
    });
  }

  // A store several services touch: coupled through its schema, its locks and its uptime.
  for (const node of analysis.nodes.values()) {
    if (node.group !== 'data') continue;
    const writers: string[] = [];
    const readers: string[] = [];
    for (const interaction of inOf(node.id)) {
      if (interaction.class !== 'data' || graph.roles.get(interaction.from) !== 'compute') continue;
      const verb = verbOf(interaction);
      (verb === 'reads' ? readers : writers).push(interaction.from);
    }
    const services = [...new Set([...writers, ...readers])];
    if (services.length < 2) continue;
    const who = [
      writers.length > 0 ? `${names(writers)} ${writers.length === 1 ? 'writes' : 'write'} ${name(node.id)}` : '',
      readers.length > 0 ? `${names(readers)} ${readers.length === 1 ? 'reads' : 'read'} ${writers.length > 0 ? 'it' : name(node.id)}` : '',
    ]
      .filter(Boolean)
      .join(' and ');
    add({
      kind: 'shared-dependency',
      note: `${services.length} services, one store`,
      focus: [node.id],
      severity: 'notable',
      basis: 'modeled',
      nodeIds: [node.id, ...services],
      edgeIds: [],
      text:
        writers.length >= 2
          ? `${who} — ${services.length} services coupled through one store: a schema change, a lock or an outage there touches every one of them, their writes can contend, and no single service clearly owns it.`
          : `${who} — ${services.length} services coupled through one store: a schema change, a slow query or an outage there reaches every one of them.`,
    });
  }

  // Someone else's system on a request's critical path, with nothing drawn for when it fails.
  const externalCallers = new Map<string, string[]>();
  for (const interaction of analysis.interactions) {
    if (interaction.class !== 'request' || !interaction.sync || interaction.loop || categoryOf(nodes.get(interaction.to)!) !== 'external') continue;
    const list = externalCallers.get(interaction.from) ?? [];
    list.push(interaction.to);
    externalCallers.set(interaction.from, list);
  }
  for (const [caller, externals] of [...externalCallers].sort((a, b) => compareText(a[0], b[0]))) {
    // A fallback connector says something is there when a call fails — not which call it covers,
    // so one drawn anywhere from the caller softens this to a question rather than clearing it.
    const fallback = hasFallback(caller);
    add({
      kind: 'external-on-sync',
      severity: fallback ? 'unknown' : 'notable',
      basis: 'structural',
      nodeIds: [caller, ...externals],
      edgeIds: [],
      note: fallback ? 'fallback covers this?' : 'no fallback!',
      focus: externals,
      text: fallback
        ? `${name(caller)} waits on ${names(externals)} synchronously. A fallback is drawn from ${name(caller)}, but not which of its calls it covers — check that ${externals.length === 1 ? 'this one is' : 'these are'} among them.`
        : `${name(caller)} waits on ${names(externals)} synchronously and no fallback is drawn — when ${externals.length === 1 ? 'it is' : 'they are'} down or slow, ${name(caller)} is too. To contain it, draw what ${name(caller)} falls back to — another provider, a cached answer, a queue to retry from — and set that connector's behaviour to Fallback.`,
    });
  }
  for (const node of analysis.nodes.values()) {
    if (categoryOf(nodes.get(node.id)!) !== 'external') continue;
    const callers = node.sources.filter((id) => graph.roles.get(id) === 'compute');
    if (callers.length < 2) continue;
    add({
      kind: 'shared-dependency',
      note: 'shared by all, run by none',
      focus: [node.id],
      severity: 'notable',
      basis: 'modeled',
      nodeIds: [node.id, ...callers],
      edgeIds: [],
      text: `${names(callers)} all depend on ${name(node.id)}, which you don't run: its outages and limits become theirs, and none of them can fix it.`,
    });
  }

  // Messages with nowhere to go: published, but nothing drawn takes them off.
  for (const node of analysis.nodes.values()) {
    if (node.role !== 'messaging') continue;
    // A dead-letter queue is fed by failures, which carry no baseline paths — so "fed" here is any
    // connector arriving, of any class.
    const deadLetter = categoryOf(nodes.get(node.id)!) === 'deadLetter';
    const feeding = analysis.interactions.filter(
      (interaction) => interaction.to === node.id && (deadLetter ? interaction.class === 'failure' : interaction.class === 'publish'),
    );
    if (feeding.length === 0) continue;
    const consumers = analysis.interactions.filter((interaction) => interaction.from === node.id && interaction.class === 'deliver');
    if (consumers.length > 0) continue;
    const producers = [...new Set(feeding.map((interaction) => interaction.from))];
    add({
      kind: 'dead-end',
      severity: 'notable',
      basis: 'structural',
      nodeIds: [node.id, ...producers],
      edgeIds: [],
      note: deadLetter ? 'nobody drains this' : 'nobody reads this',
      focus: [node.id],
      text: deadLetter
        ? `Failed messages land in ${name(node.id)} and nothing drawn handles them — they will sit there unseen. Draw who replays or inspects them, or at least alert on its depth.`
        : `${names(producers)} ${producers.length === 1 ? 'publishes' : 'publish'} to ${name(node.id)}, but nothing drawn consumes it — either a consumer is missing from the diagram, or that work goes nowhere.`,
    });
  }

  // A gateway in front of a service that is also reached around it: the gateway's checks don't apply there.
  for (const node of analysis.nodes.values()) {
    if (node.role !== 'compute') continue;
    const callers = inOf(node.id).filter((interaction) => interaction.class === 'request');
    const gateways = callers.filter((interaction) => categoryOf(nodes.get(interaction.from)!) === 'gateway').map((interaction) => interaction.from);
    if (gateways.length === 0) continue;
    const around = callers
      .map((interaction) => interaction.from)
      .filter((id) => graph.roles.get(id) === 'origin' || (isEntryNode(id) && categoryOf(nodes.get(id)!) !== 'gateway'));
    if (around.length === 0) continue;
    add({
      kind: 'gateway-bypass',
      severity: 'unknown',
      basis: 'structural',
      nodeIds: [node.id, ...gateways, ...around],
      edgeIds: [],
      note: 'around the gateway?',
      focus: [node.id],
      text: `${name(node.id)} sits behind ${names(gateways)}, and ${names(around)} also ${around.length === 1 ? 'calls' : 'call'} it directly. Whether that path is meant to skip what the gateway does — authentication, throttling, routing — isn't shown; worth confirming it is intentional.`,
    });
  }

  // Where every journey from an entry has to pass.
  const hubs = new Set<string>();
  const candidates = [...analysis.nodes.values()]
    // Only where every entry is listed: a hub claim needs all of them checked, not the first fifty.
    .filter((node) => node.role === 'compute' && !node.isEntry && node.entries.length > 0 && node.entries.length === node.entryCount && node.targets.length >= 2)
    .sort((a, b) => b.paths.possible - a.paths.possible || compareText(a.id, b.id))
    .slice(0, MAX_HUB_CANDIDATES);
  for (const node of candidates) {
    const targets = new Set(node.targets);
    const seen = new Set<string>([node.id]);
    const pending = [...node.entries];
    let bypassed = false;
    for (let head = 0; head < pending.length && !bypassed; head += 1) {
      const current = pending[head]!;
      if (seen.has(current)) continue;
      seen.add(current);
      if (targets.has(current)) bypassed = true;
      for (const interaction of outOf(current)) if (!seen.has(interaction.to)) pending.push(interaction.to);
    }
    if (bypassed) continue;
    hubs.add(node.id);
  }
  // One finding per way in, each saying whose: "only way in" alone, beside one of two entry
  // services, reads as if that one were the only entrance to the whole system.
  for (const id of [...hubs].sort(compareText)) {
    const entries = analysis.nodes.get(id)!.entries;
    const others = analysis.entries.filter((entry) => !entries.includes(entry) && graph.roles.get(entry) === 'origin');
    add({
      kind: 'hub',
      note: `only way in for ${names(entries)}`,
      focus: [id],
      severity: 'notable',
      basis: 'modeled',
      nodeIds: [id, ...entries],
      edgeIds: [],
      text: `Everything from ${names(entries)} goes through ${name(id)} — if it is down, ${names(entries)} ${entries.length === 1 ? 'is' : 'are'} cut off however healthy the rest is${others.length > 0 ? `, while ${names(others)} ${others.length === 1 ? 'comes' : 'come'} in another way` : ''}. Run more than one, or give it a fallback.`,
    });
  }

  // Amplification: one element reaching another along several routes. If it makes every call
  // drawn, the far one pays once per route — the multiplier that hides in a tidy diagram.
  const routeCache = new Map<string, Map<string, { count: number; via: Set<string> }>>();
  const routesFrom = (start: string): Map<string, { count: number; via: Set<string> }> => {
    const cached = routeCache.get(start);
    if (cached) return cached;
    const count = new Map<string, number>([[start, 1]]);
    const via = new Map<string, Set<string>>();
    const order: string[] = [];
    const indegree = new Map<string, number>();
    const pending = [start];
    const reach = new Set([start]);
    for (let head = 0; head < pending.length; head += 1) {
      for (const interaction of outOf(pending[head]!)) {
        if (interaction.loop) continue;
        indegree.set(interaction.to, (indegree.get(interaction.to) ?? 0) + 1);
        if (!reach.has(interaction.to)) {
          reach.add(interaction.to);
          pending.push(interaction.to);
        }
      }
    }
    const ready = [start];
    for (let head = 0; head < ready.length; head += 1) {
      const at = ready[head]!;
      order.push(at);
      for (const interaction of outOf(at)) {
        if (interaction.loop) continue;
        count.set(interaction.to, Math.min(999, (count.get(interaction.to) ?? 0) + count.get(at)!));
        const set = via.get(interaction.to) ?? new Set<string>();
        set.add(at);
        via.set(interaction.to, set);
        const left = indegree.get(interaction.to)! - 1;
        indegree.set(interaction.to, left);
        if (left === 0) ready.push(interaction.to);
      }
    }
    const result = new Map<string, { count: number; via: Set<string> }>();
    for (const at of order) if (at !== start) result.set(at, { count: count.get(at) ?? 0, via: via.get(at) ?? new Set() });
    routeCache.set(start, result);
    return result;
  };
  const amplified: { from: string; to: string; count: number; via: string[] }[] = [];
  for (const node of [...analysis.nodes.values()].filter((item) => item.role === 'compute' && item.targets.length >= 2).slice(0, MAX_HUB_CANDIDATES)) {
    for (const [to, route] of routesFrom(node.id)) {
      // Only the double hit: reaching it directly and again through something it calls. Routes that
      // part at a fan-out (browse here, buy there) are different requests, not one multiplied.
      if (route.count < 2 || graph.roles.get(to) === 'origin' || !route.via.has(node.id)) continue;
      // Only where the routes part — further upstream the same multiplier is just inherited.
      if (node.targets.filter((target) => target === to || routesFrom(target).has(to)).length < 2) continue;
      amplified.push({ from: node.id, to, count: route.count, via: [...route.via].map((id) => (id === node.id ? 'directly' : `through ${name(id)}`)) });
    }
  }
  amplified.sort((a, b) => b.count - a.count || compareText(a.from, b.from) || compareText(a.to, b.to));
  for (const item of amplified.slice(0, 3)) {
    const [one, many] = unitOf(item.to);
    add({
      kind: 'amplification',
      note: `hit ${item.count}× per ${name(item.from)}`,
      focus: [item.to],
      severity: 'notable',
      basis: 'modeled',
      nodeIds: [item.to, item.from],
      edgeIds: [],
      text: `${name(item.from)} reaches ${name(item.to)} along ${item.count} routes — ${joinNames(item.via)} — so a ${name(item.from)} request that makes every call drawn costs ${name(item.to)} ${item.count} ${item.count === 1 ? one : many}. Worth checking whether one could pass along what the other already has.`,
    });
  }

  // A request that needs many things up at once — and which of them nothing protects it from.
  for (const node of analysis.nodes.values()) {
    if (node.role !== 'compute' || node.targets.length < 3 || hubs.has(node.id)) continue;
    // Only what every request certainly waits on: one branch of a split is a "may", and an
    // asynchronous write is not waited on at all.
    const blocking = [...new Set(outOf(node.id).filter((interaction) => (interaction.class === 'request' || interaction.class === 'data') && interaction.sync && interaction.certainty === 'definite').map((interaction) => interaction.to))];
    const handedOff = [...new Set(outOf(node.id).filter((interaction) => interaction.class === 'publish').map((interaction) => interaction.to))];
    if (blocking.length < 2) continue;
    const covered = hasFallback(node.id);
    add({
      kind: 'fan-out',
      severity: 'info',
      basis: 'structural',
      nodeIds: [node.id, ...node.targets],
      edgeIds: [],
      note: `needs ${blocking.length} things up`,
      focus: [node.id],
      text: `A ${name(node.id)} request needs ${names(blocking)} all up at once${covered ? '' : ', and no fallback is drawn for any of them'} — any one failing blocks it, so it can be no more available than all of them together.${handedOff.length > 0 ? ` ${names(handedOff)} ${handedOff.length === 1 ? 'is' : 'are'} already handed off asynchronously and can't block it.` : ''}`,
    });
  }

  // The longest run a person or job can be kept waiting: every hop adds its latency and failures.
  const waitNext = new Map<string, string[]>();
  for (const interaction of analysis.interactions) {
    if (interaction.loop || !(interaction.class === 'request' || interaction.class === 'data') || !interaction.sync || interaction.certainty !== 'definite') continue;
    const list = waitNext.get(interaction.from);
    if (list) list.push(interaction.to);
    else waitNext.set(interaction.from, [interaction.to]);
  }
  const longest = new Map<string, string[]>();
  const chainFrom = (start: string): string[] => {
    const stack: { id: string; expanded: boolean }[] = [{ id: start, expanded: false }];
    const onPath = new Set<string>();
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      if (longest.has(top.id)) {
        stack.pop();
        continue;
      }
      const next = [...(waitNext.get(top.id) ?? [])].sort(compareText);
      if (!top.expanded) {
        top.expanded = true;
        onPath.add(top.id);
        for (const id of next) if (!longest.has(id) && !onPath.has(id)) stack.push({ id, expanded: false });
        continue;
      }
      stack.pop();
      onPath.delete(top.id);
      let best: string[] = [];
      for (const id of next) {
        const tail = longest.get(id);
        if (tail && tail.length > best.length) best = tail;
      }
      longest.set(top.id, [top.id, ...best]);
    }
    return longest.get(start)!;
  };
  const chains = analysis.entries
    .filter((id) => waitNext.has(id))
    .map(chainFrom)
    // From a person, the first hop is theirs; from a service, the chain starts with it.
    .filter((chain) => chain.length - 1 >= 3)
    .sort((a, b) => b.length - a.length || compareText(a[0]!, b[0]!))
    .slice(0, 2);
  /** The call worth making asynchronous: the deepest service-to-service hop, if its answer isn't needed to respond. */
  const cutOf = (chain: string[]): string => {
    for (let index = chain.length - 2; index >= 1; index -= 1) {
      const from = chain[index]!;
      const to = chain[index + 1]!;
      if (graph.roles.get(from) === 'compute' && graph.roles.get(to) === 'compute') {
        return `Every hop adds its latency and failures; if ${name(from)} doesn't need ${name(to)}'s answer to respond, that is the call to put behind a queue.`;
      }
    }
    return 'Every hop adds its latency and failures to what the caller sees.';
  };
  const byTail = new Map<string, string[][]>();
  for (const chain of analysis.entries.filter((id) => waitNext.has(id)).map(chainFrom).filter((chain) => chain.length - 1 >= 3)) {
    const key = chain.slice(2).join('>');
    byTail.set(key, [...(byTail.get(key) ?? []), chain]);
  }
  for (const group of [...byTail.values()].sort((a, b) => b[0]!.length - a[0]!.length || compareText(a[0]![0]!, b[0]![0]!)).slice(0, 2)) {
    if (group.length === 1) continue;
    const starts = group.map((chain) => chain[0]!);
    const firsts = group.map((chain) => name(chain[1]!));
    const tail = group[0]!.slice(2).map(name);
    add({
      kind: 'sync-chain',
      note: `${group[0]!.length - 1} hops, all waiting`,
      focus: group[0]!.slice(1),
      severity: 'info',
      basis: 'structural',
      nodeIds: [...new Set(group.flat())],
      edgeIds: [],
      text: `${names(starts)} requests can wait on ${group[0]!.length - 1} hops in a row — ${joinNames([...new Set(firsts)])}, then ${tail.join(' → ')}. ${cutOf(group[0]!)}`,
    });
  }
  for (const chain of chains.filter((item) => byTail.get(item.slice(2).join('>'))!.length === 1)) {
    const [start, ...hops] = chain;
    add({
      kind: 'sync-chain',
      note: `${hops.length} hops, all waiting`,
      focus: hops,
      severity: 'info',
      basis: 'structural',
      nodeIds: chain,
      edgeIds: [],
      text: `A ${name(start!)} request can wait on ${hops.length} hops in a row — ${hops.map(name).join(' → ')}. ${cutOf(chain)}`,
    });
  }

  // Messaging: what a queue buys, what a topic multiplies, what consumers share.
  for (const node of analysis.nodes.values()) {
    if (node.role !== 'messaging') continue;
    const original = nodes.get(node.id)!;
    const category = categoryOf(original);
    const producers = inOf(node.id).filter((interaction) => interaction.class === 'publish' || interaction.class === 'deliver');
    const consumers = outOf(node.id).filter((interaction) => interaction.class === 'deliver');
    const producerIds = [...new Set(producers.map((interaction) => interaction.from))];
    const consumerIds = consumers.map((interaction) => interaction.to);
    if (producers.length === 0 || consumers.length === 0) continue;
    if (category === 'queue') {
      add({
        kind: 'async-buffer',
        note: 'backlog shows here',
        focus: [node.id],
        severity: 'info',
        basis: 'structural',
        nodeIds: [node.id, ...producerIds, ...consumerIds],
        edgeIds: [...producers[0]!.edgeIds, ...consumers[0]!.edgeIds],
        text: `${name(node.id)} lets ${names(consumerIds)} fall behind or fail without slowing ${names(producerIds)} — the work waits instead. Whether a backlog builds depends on rates the diagram doesn't hold, so it is the queue to watch and alert on.`,
      });
      if (consumers.length >= 2) {
        add({
          kind: 'competing-consumers',
          note: 'who gets what?',
          focus: [node.id],
          severity: 'unknown',
          basis: 'structural',
          nodeIds: [node.id, ...consumerIds],
          edgeIds: consumers.flatMap((interaction) => interaction.edgeIds),
          text: `${names(consumerIds)} take turns on ${name(node.id)} — each message goes to one of them, in a share the diagram doesn't give, and one stuck consumer leaves its share to the rest.`,
        });
      }
    }
    if ((category === 'topic' || category === 'stream') && consumers.length >= 2) {
      add({
        kind: 'message-distribution',
        note: `every message ×${consumers.length}`,
        focus: [node.id],
        severity: 'info',
        basis: 'modeled',
        nodeIds: [node.id, ...consumerIds],
        edgeIds: consumers.flatMap((interaction) => interaction.edgeIds),
        text: `Every message ${names(producerIds)} ${producerIds.length === 1 ? 'puts' : 'put'} on ${name(node.id)} is handled ${consumers.length === 2 ? 'twice' : `${consumers.length} times`} — by ${names(consumerIds)} — each at its own pace, none of them slowing ${names(producerIds)}. Each new subscriber adds a full copy of that work.`,
      });
    }
  }

  // What the diagram leaves unsaid about the traffic it does describe.
  for (const interaction of analysis.interactions) {
    if (interaction.class === 'retry') {
      const attempts = interaction.edgeIds.map((id) => drawn.get(id)?.deliveryAttempts).find((value) => value !== undefined);
      add({
        kind: 'retry-amplification',
        note: 'retries pile on',
        focus: [interaction.to],
        severity: 'unknown',
        basis: 'structural',
        nodeIds: [interaction.to, interaction.from],
        edgeIds: interaction.edgeIds,
        text:
          attempts === undefined
            ? `${name(interaction.from)} retries ${name(interaction.to)}: when ${name(interaction.to)} struggles, it gets more traffic, not less. How many retries isn't drawn — backoff and a cap keep it from piling on.`
            : `${name(interaction.from)} retries ${name(interaction.to)} up to ${attempts} times: when ${name(interaction.to)} struggles, it can see up to ${attempts}× the traffic.`,
      });
    }
    if (interaction.uncertainty === 'conditional') {
      const condition = interaction.edgeIds.map((id) => drawn.get(id)?.condition?.trim()).find((value) => value);
      add({
        kind: 'conditional',
        severity: 'unknown',
        basis: 'structural',
        nodeIds: [interaction.to, interaction.from],
        edgeIds: interaction.edgeIds,
        text: `Only some traffic from ${name(interaction.from)} takes the ${condition ? `'${condition}' ` : ''}branch to ${name(interaction.to)}, so ${name(interaction.to)} is counted as possibly reached, not certainly.`,
      });
    }
  }

  for (const component of context.components) {
    if (!component.loop) continue;
    add({
      kind: 'loop',
      note: 'feeds itself',
      focus: component.members,
      severity: 'unknown',
      basis: 'structural',
      nodeIds: component.members,
      edgeIds: analysis.interactions.filter((interaction) => interaction.loop && component.members.includes(interaction.from)).flatMap((interaction) => interaction.edgeIds),
      text:
        component.members.length === 1
          ? `${name(component.members[0]!)} sends traffic back to itself — if that repeats unchecked it feeds on its own load. Counted once here.`
          : `${names(component.members)} call each other in a loop — under a retry or a failure it can feed itself and spread between them. Counted once here; how often it repeats isn't drawn.`,
    });
  }

  for (const id of analysis.entries) {
    if (categoryOf(nodes.get(id)!) !== 'scheduler') continue;
    const reached = [...new Set(outOf(id).map((interaction) => interaction.to))];
    add({
      kind: 'scheduler',
      note: 'bursts on a timer',
      focus: [id],
      severity: 'unknown',
      basis: 'structural',
      nodeIds: [id, ...reached],
      edgeIds: [],
      text: `${name(id)} starts work on its own schedule, so ${names(reached)} ${reached.length === 1 ? 'gets' : 'get'} bursts no user caused — worth knowing when they run alongside peak traffic.`,
    });
  }

  // A gateway's routes: each request goes to one of them, in a share nobody drew.
  for (const id of [...outgoing.keys()].sort(compareText)) {
    const routed = outOf(id).filter((interaction) => interaction.uncertainty === 'routed');
    if (routed.length < 2) continue;
    add({
      kind: 'routed-split',
      note: 'split unknown',
      focus: [id],
      severity: 'unknown',
      basis: 'structural',
      nodeIds: [id, ...routed.map((interaction) => interaction.to)],
      edgeIds: routed.flatMap((interaction) => interaction.edgeIds),
      text: `${name(id)} routes each request to one of ${names(routed.map((interaction) => interaction.to))}, so they are counted as possibly reached; which routes carry most of the traffic isn't drawn.`,
    });
  }

  // What the baseline leaves out on purpose, counted once.
  const left = new Map<string, number>();
  const LEFT_OUT: Partial<Record<string, [string, string]>> = {
    failure: ['failure path', 'failure paths'],
    background: ['background data flow', 'background data flows'],
    callback: ['callback', 'callbacks'],
    retry: ['retry path', 'retry paths'],
  };
  const leftEdges: string[] = [];
  for (const edge of graph.edgeList) {
    const kind = graph.edges.get(edge.id)?.class;
    if (!kind || !LEFT_OUT[kind]) continue;
    left.set(kind, (left.get(kind) ?? 0) + 1);
    leftEdges.push(edge.id);
  }
  if (left.size > 0) {
    const pieces = [...left]
      .sort((a, b) => compareText(a[0], b[0]))
      .map(([kind, count]) => {
        const [one, many] = LEFT_OUT[kind]!;
        return plural(count, one, many);
      });
    const total = [...left.values()].reduce((sum, value) => sum + value, 0);
    add({
      kind: 'not-counted',
      severity: 'info',
      basis: 'structural',
      nodeIds: [],
      edgeIds: leftEdges,
      text: `${joinNames(pieces)} ${total === 1 ? "isn't" : "aren't"} part of baseline traffic.`,
    });
  }

  if (analysis.status === 'ok' && analysis.hotspots.length === 0) {
    const reached = [...analysis.nodes.values()].filter((node) => node.role !== 'excluded' && node.role !== 'junction' && node.role !== 'origin' && node.paths.possible > 0);
    const once = reached.every((node) => node.paths.possible === 1);
    add({
      kind: 'no-concentration',
      severity: 'info',
      basis: 'modeled',
      nodeIds: [],
      edgeIds: [],
      text: once
        ? 'No single part of this diagram receives more modeled paths than the rest — each is reached by one path.'
        : 'No part of this diagram is where paths concentrate.',
    });
  }

  const unique = new Map<string, TrafficInsight>();
  for (const seed of seeds) {
    const insight: TrafficInsight = { id: idFor(seed), ...seed };
    if (!unique.has(insight.id)) unique.set(insight.id, insight);
  }
  return [...unique.values()]
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || compareText(a.id, b.id),
    )
    .slice(0, MAX_INSIGHTS);
}
