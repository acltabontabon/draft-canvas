import { categoryOf, type NodeCategory } from '../document/connectorSemantics';
import { displayNameFor } from '../document/factory';
import type { DraftEdge, DraftNode, EdgeSemantic } from '../document/types';
import { trafficRoleOf } from './eligibility';
import { outageFact } from './technology';
import type { TrafficAnalysis, TrafficInteraction } from './types';

/**
 * Take one shape down and read what follows — from the drawing alone.
 *
 * No rates, no likelihoods: only what the shapes and connectors already say. A caller that waits on
 * the shape fails with it; a queue in front of it holds; a queue in front of something *failing*
 * redelivers and, where one is drawn, dead-letters; a store nothing writes to any more goes stale;
 * whatever only it fed goes quiet. What a shape is decides how it reads: a Service drawn with
 * several instances loses one before it loses all, a cache is fallen through rather than waited on,
 * a topic keeps events or doesn't according to the product it is drawn as, and a Boundary taken
 * down takes everything inside it.
 *
 * Where the drawing stops short of an answer (no fallback, no dead-letter route, no replay, a
 * single instance) the result is a question for the person — with the edit that would answer it
 * when one exists — never a guess.
 *
 * Imports `document/` only: no React, store, canvas or DOM.
 */

/**
 * `down`: taken down. `failing`: waits on something down or failing, with no fallback drawn.
 * `degraded`: affected, but not wholly — a fallback is drawn, only one of its routes or instances
 * is hit, or the drawing doesn't say. `holding`: messaging whose consumer is down; messages wait.
 * `retrying`: messaging whose consumer is failing; deliveries come back. `catching`: where a drawn
 * fallback or dead-letter route now leads. `stale`: a store still read but no longer written.
 * `quiet`: nothing reaches it any more. `unaffected`: carries on as before.
 */
export type OutageState = 'down' | 'failing' | 'degraded' | 'holding' | 'retrying' | 'catching' | 'stale' | 'quiet' | 'unaffected';

/** `failing`: a call or delivery that now fails. `stopped`: nothing travels it. `recovery`: a
 *  fallback or dead-letter route the outage brings into use. */
export type OutageEdgeState = 'failing' | 'stopped' | 'recovery';

/** An edit that would answer a question — applied by the editor as one ordinary, undoable step. */
export type OutageFix =
  | { kind: 'dead-letter'; queue: string }
  | { kind: 'replay'; from: string; to: string }
  | { kind: 'instances'; node: string };

export interface OutageNote {
  /** Stable for the same outage: `${kind}:${subject ids}`. */
  id: string;
  /** `effect`: what happens. `shield`: what stops it spreading. `question`: what the drawing leaves open. */
  tone: 'effect' | 'shield' | 'question';
  /** A few words to write beside `focus`. */
  note: string;
  /** One or two plain sentences, in the diagram's own names. */
  text: string;
  focus: string[];
  /** For a question: how it would read as an open point on `focus[0]`. */
  ask?: string;
  fix?: OutageFix;
}

/** What is taken down: a shape, or a Boundary and everything in it. `whole` takes every instance of
 *  a Service drawn with several; without it, one of them. */
export interface OutageTarget {
  id: string;
  whole?: boolean;
}

export interface Outage {
  target: string;
  /** The runtime shapes that are down: the target, or what its Boundary holds. */
  lost: string[];
  /** Set when only one of a Service's instances is down. */
  instances?: { down: number; of: number };
  headline: string;
  /** Every runtime shape that takes part, with what the outage does to it. */
  nodes: Map<string, OutageState>;
  /** Connectors the outage changes; absent means it carries on as drawn. */
  edges: Map<string, OutageEdgeState>;
  /** In the order the consequence travels: failures, then what absorbs them, then what goes quiet. */
  notes: OutageNote[];
}

/** Whoever makes this interaction holds its request open until it returns. */
export function waitsOn(interaction: TrafficInteraction): boolean {
  if (interaction.loop) return false;
  return (interaction.class === 'request' || interaction.class === 'data') && interaction.sync;
}

function runs(node: DraftNode): boolean {
  const role = trafficRoleOf(node);
  return role === 'compute' || role === 'messaging' || role === 'data';
}

/** The runtime shapes a target stands for: itself, or everything that runs inside its Boundary. */
export function lostBy(nodes: readonly DraftNode[], id: string): string[] {
  const target = nodes.find((node) => node.id === id);
  if (!target) return [];
  if (target.type !== 'group') return runs(target) ? [id] : [];
  const parents = new Map(nodes.map((node) => [node.id, node.parentId]));
  return nodes
    .filter((node) => {
      if (!runs(node)) return false;
      // Bounded by the node count, so a malformed parent loop ends.
      for (let at = node.parentId, steps = 0; at && steps <= nodes.length; at = parents.get(at), steps += 1) if (at === id) return true;
      return false;
    })
    .map((node) => node.id);
}

/** Whether a shape is the kind of thing an outage can be read from, before any analysis. */
export function mayTakeDown(nodes: readonly DraftNode[], id: string): boolean {
  return lostBy(nodes, id).length > 0;
}

/** Whether taking this down says anything: something that runs and takes part in the drawing. */
export function canTakeDown(analysis: TrafficAnalysis, nodes: readonly DraftNode[], id: string): boolean {
  return lostBy(nodes, id).some((lost) => analysis.nodes.has(lost));
}

const WRITES = new Set<EdgeSemantic>(['writes', 'readsWrites', 'indexes', 'ingests', 'invalidates']);
const READS = new Set<EdgeSemantic>(['reads', 'readsWrites', 'query', 'searches', 'watches']);
const QUEUES = new Set<NodeCategory>(['queue', 'deadLetter']);

export function outageOf(
  analysis: TrafficAnalysis,
  nodes: readonly DraftNode[],
  edges: readonly DraftEdge[],
  target: OutageTarget,
): Outage | null {
  const drawn = new Map(nodes.map((node) => [node.id, node]));
  const targetNode = drawn.get(target.id);
  const lost = lostBy(nodes, target.id).filter((id) => analysis.nodes.has(id));
  if (!targetNode || lost.length === 0) return null;
  const down = new Set(lost);
  const edgeById = new Map(edges.map((edge) => [edge.id, edge]));

  const name = (id: string) => {
    const node = drawn.get(id);
    if (!node) return 'Untitled';
    // An unnamed dead-letter queue would otherwise read as its kind's default, "Queue".
    if (node.deliveryRole === 'dead-letter' && !node.text?.trim()) return 'the dead-letter queue';
    return displayNameFor(node) || 'Untitled';
  };
  const roleOf = (id: string) => analysis.nodes.get(id)?.role;
  const categoryAt = (id: string) => {
    const node = drawn.get(id);
    return node ? categoryOf(node) : undefined;
  };
  const targetName = name(target.id);
  const outName = targetNode.type === 'group' ? `everything in ${targetName}` : targetName;

  const state = new Map<string, OutageState>();
  const edgeState = new Map<string, OutageEdgeState>();
  const notes: OutageNote[] = [];
  const baseline = analysis.interactions.filter((item) => item.paths.possible > 0);
  const takesPart = (id: string) => {
    const node = analysis.nodes.get(id);
    return !!node && node.role !== 'excluded' && node.role !== 'junction' && (node.isEntry || node.paths.possible > 0);
  };
  const finish = (headline: string, instances?: Outage['instances']): Outage => ({
    target: target.id,
    lost,
    ...(instances ? { instances } : {}),
    headline,
    nodes: state,
    edges: edgeState,
    notes,
  });

  // A Service drawn with several instances loses one before it loses all of them.
  const instanceCount = targetNode.type === 'service' ? (targetNode.replicas ?? 1) : 1;
  if (instanceCount >= 2 && !target.whole) {
    for (const node of analysis.nodes.values()) if (takesPart(node.id)) state.set(node.id, 'unaffected');
    state.set(target.id, 'degraded');
    const left = instanceCount - 1;
    const others = left === 1 ? 'the other keeps' : `the other ${left} keep`;
    const feeds = baseline.filter((item) => item.to === target.id && item.class === 'deliver').map((item) => item.from);
    notes.push({
      id: `instances:${target.id}`,
      tone: 'shield',
      note: `${left} of ${instanceCount} still running`,
      text: feeds.length > 0
        ? `${targetName} is drawn with ${instanceCount} instances, so ${others} taking work from ${listOf(feeds.map(name))} — slower, not stopped.`
        : `${targetName} is drawn with ${instanceCount} instances, so ${others} answering — with less room than before.`,
      focus: [target.id],
    });
    return finish(`One of ${instanceCount} ${targetName} instances is down. Everything drawn carries on.`, { down: 1, of: instanceCount });
  }

  for (const id of lost) state.set(id, 'down');
  const compensating = new Set(edges.filter((edge) => edge.semantic === 'compensates').map((edge) => edge.id));
  const into = group(baseline, (item) => item.to);
  const outOf = group(baseline, (item) => item.from);
  // A drawn way out of a failure: a fallback from a caller, a dead-letter route from a queue.
  // Compensation undoes finished work; it is not somewhere a failing call can go instead.
  const escapes = group(
    analysis.interactions.filter((item) => item.class === 'failure' && !item.edgeIds.some((id) => compensating.has(id))),
    (item) => item.from,
  );
  const retries = analysis.interactions.filter((item) => item.class === 'retry');
  const mark = (item: TrafficInteraction, value: OutageEdgeState) => {
    for (const id of item.edgeIds) if (edgeState.get(id) !== 'recovery') edgeState.set(id, value);
  };
  const semanticsOf = (item: TrafficInteraction) => item.edgeIds.map((id) => edgeById.get(id)?.semantic);
  // An unlabelled data connector may be either; a labelled one says which.
  const writes = (item: TrafficInteraction) => semanticsOf(item).some((semantic) => !semantic || WRITES.has(semantic));
  const reads = (item: TrafficInteraction) => semanticsOf(item).some((semantic) => !semantic || READS.has(semantic));

  // 1. Whoever waits on it fails with it, hop by hop, until a fallback or a partial route stops it.
  const direct: string[] = [];
  const further: string[] = [];
  const people: string[] = [];
  const partial: string[] = [];
  const fellBack: { from: string; to: string[] }[] = [];
  const failed = [...lost];
  for (let head = 0; head < failed.length; head += 1) {
    const at = failed[head]!;
    for (const item of into.get(at) ?? []) {
      if (!waitsOn(item) || state.has(item.from)) continue;
      mark(item, 'failing');
      const caller = item.from;
      const fallback = roleOf(caller) === 'messaging' ? [] : (escapes.get(caller) ?? []);
      if (fallback.length > 0) {
        state.set(caller, 'degraded');
        for (const route of fallback) {
          mark(route, 'recovery');
          if (!state.has(route.to)) state.set(route.to, 'catching');
        }
        fellBack.push({ from: caller, to: [...new Set(fallback.map((route) => route.to))] });
        continue;
      }
      // A cache is in front of something, not the thing itself: without it a read is a miss.
      if (down.has(at) && categoryAt(at) === 'cache') {
        state.set(caller, 'degraded');
        const source = (outOf.get(caller) ?? []).find((other) => other.class === 'data' && !down.has(other.to) && categoryAt(other.to) !== 'cache' && reads(other))?.to;
        const fact = outageFact(drawn.get(at))?.down;
        notes.push({
          id: `cache-miss:${caller}:${at}`,
          tone: 'question',
          note: source ? `every read falls to ${name(source)}?` : 'every read is a miss — then what?',
          text: `${name(caller)} reads ${name(at)}. Nothing drawn says whether it ${source ? `falls through to ${name(source)}, which would then take every read,` : 'falls through to the source'} or fails.${fact ? ` ${fact}` : ''}`,
          focus: [caller],
          ask: source ? `Does ${name(caller)} fall through to ${name(source)} when ${name(at)} is down, and can ${name(source)} take every read?` : `What does ${name(caller)} do when ${name(at)} is down?`,
        });
        continue;
      }
      if (item.certainty === 'possible') {
        state.set(caller, 'degraded');
        partial.push(caller);
        continue;
      }
      state.set(caller, 'failing');
      failed.push(caller);
      if (roleOf(caller) === 'origin') people.push(caller);
      else (down.has(at) ? direct : further).push(caller);
    }
  }
  if (direct.length > 0) {
    const outside = lost.length === 1 && categoryAt(lost[0]!) === 'external';
    notes.push({
      id: `no-fallback:${direct.join(',')}`,
      tone: 'question',
      note: 'calls fail — no fallback drawn',
      text: `${listOf(direct.map(name))} ${direct.length === 1 ? 'waits' : 'wait'} on ${outName}, and nothing drawn says what happens instead.${outside ? ` ${targetName} is outside your system, so its recovery isn't yours to speed up.` : ''}`,
      focus: direct,
      ask: `What should ${name(direct[0]!)} do while ${targetName} is down?`,
    });
    const hammering = retries.filter((item) => direct.includes(item.from) && down.has(item.to));
    if (hammering.length > 0) {
      for (const item of hammering) mark(item, 'failing');
      const callers = [...new Set(hammering.map((item) => item.from))];
      notes.push({
        id: `retries:${callers.join(',')}`,
        tone: 'effect',
        note: 'retries pile onto it',
        text: `${listOf(callers.map(name))} ${callers.length === 1 ? 'retries' : 'retry'} as drawn, so ${targetName} comes back to its normal work plus every retry that queued up meanwhile.`,
        focus: callers,
      });
    }
  }
  if (further.length > 0) {
    notes.push({
      id: `chain:${further.join(',')}`,
      tone: 'effect',
      note: further.length === 1 ? 'fails with it' : 'fail with it',
      text: `${listOf(further.map(name))} ${further.length === 1 ? 'waits' : 'wait'} on something that is failing, so the failure travels back up the chain.`,
      focus: further,
    });
  }
  for (const { from, to } of fellBack) {
    notes.push({
      id: `fallback:${from}`,
      tone: 'shield',
      note: `falls back to ${listOf(to.map(name))}`,
      text: `${name(from)} has a fallback drawn, so the failure stops here.`,
      focus: [from],
    });
  }
  if (partial.length > 0) {
    notes.push({
      id: `partial:${partial.join(',')}`,
      tone: 'effect',
      note: 'some requests fail',
      text: `Only one of the routes out of ${listOf(partial.map(name))} leads to ${outName}; the rest get through. The drawing doesn't say what share that is.`,
      focus: partial,
    });
  }
  if (people.length > 0) {
    notes.push({
      id: `people:${people.join(',')}`,
      tone: 'effect',
      note: people.length === 1 ? 'sees the failure' : 'see the failure',
      text: `${listOf(people.map(name))} ${people.length === 1 ? 'is' : 'are'} at the start of a chain that waits on ${outName}.`,
      focus: people,
    });
  }

  // 2. Messaging in front of the outage absorbs it: it holds for a consumer that is down, and
  //    redelivers to one that is failing — into a dead-letter queue where one is drawn.
  for (const consumer of failed) {
    if (roleOf(consumer) === 'origin') continue;
    for (const item of into.get(consumer) ?? []) {
      if (item.class !== 'deliver' || state.has(item.from)) continue;
      const queue = item.from;
      const category = categoryAt(queue);
      const fact = outageFact(drawn.get(queue));
      const said = fact?.holding ? ` ${fact.holding}` : '';
      if (down.has(consumer)) {
        mark(item, 'stopped');
        // Messaging feeding messaging (a topic into a queue that is down) has no stated behaviour.
        if (roleOf(consumer) === 'messaging') {
          state.set(queue, 'degraded');
          notes.push({
            id: `undelivered:${queue}`,
            tone: 'question',
            note: "can't deliver — held or lost?",
            text: `${name(queue)} hands messages to ${name(consumer)}. Nothing drawn says whether they wait or are dropped.${said}`,
            focus: [queue],
            ask: `What happens to messages ${name(queue)} can't deliver while ${name(consumer)} is down?`,
          });
          continue;
        }
        // A work queue hands each message to one consumer, so another consumer still drains it.
        const others = (outOf.get(queue) ?? []).filter((other) => other.class === 'deliver' && !failed.includes(other.to)).map((other) => other.to);
        if (category !== undefined && QUEUES.has(category) && others.length > 0) {
          notes.push({
            id: `shared:${queue}`,
            tone: 'shield',
            note: `${listOf(others.map(name))} ${others.length === 1 ? 'keeps' : 'keep'} draining it`,
            text: `${name(queue)} hands each message to one consumer, so ${listOf(others.map(name))} ${others.length === 1 ? 'takes' : 'take'} what ${name(consumer)} would have.`,
            focus: [queue],
          });
          continue;
        }
        // A queue or a stream keeps what arrives. A topic does only if the product it is drawn as does.
        const keeps = category === 'topic' ? fact?.retains : true;
        if (keeps !== true) {
          state.set(queue, 'degraded');
          notes.push({
            id: `missed:${queue}:${consumer}`,
            tone: 'question',
            note: keeps === false ? 'events are dropped meanwhile' : 'keeps events for it, or drops them?',
            text: `${name(consumer)} subscribes to ${name(queue)} directly, with no queue of its own in between.${said || " Nothing drawn says whether a topic keeps what a subscriber wasn't there for."}`,
            focus: [queue],
            ask: `How does ${name(consumer)} catch up on what ${name(queue)} published while it was down?`,
          });
          continue;
        }
        state.set(queue, 'holding');
        const burst = [...new Set((outOf.get(consumer) ?? []).filter(waitsOn).map((next) => next.to))];
        notes.push({
          id: `holding:${queue}`,
          tone: 'shield',
          note: category === 'queue' || category === 'deadLetter' ? "holds messages until it's back" : "keeps the log until it's back",
          text: `${name(queue)} keeps what arrives while ${name(consumer)} is down, so nothing upstream waits on it.${said} When it returns the backlog arrives at once${burst.length > 0 ? `, and ${listOf(burst.map(name))} ${burst.length === 1 ? 'takes' : 'take'} it with it` : ''}.`,
          focus: [queue],
        });
        continue;
      }
      mark(item, 'failing');
      state.set(queue, 'retrying');
      const deadLetters = escapes.get(queue) ?? [];
      if (deadLetters.length === 0) {
        notes.push({
          id: `redelivers:${queue}`,
          tone: 'question',
          note: 'keeps redelivering — no dead-letter drawn',
          text: `${name(consumer)} can't finish its work, so ${name(queue)} gets every message back. Nothing drawn says where they go after that.${said}`,
          focus: [queue],
          ask: `What happens to messages ${name(consumer)} keeps failing while ${targetName} is down?`,
          ...(category === 'queue' ? { fix: { kind: 'dead-letter' as const, queue } } : {}),
        });
        continue;
      }
      const attempts = deadLetters.flatMap((route) => route.edgeIds.map((id) => edgeById.get(id)?.deliveryAttempts)).find((count) => count !== undefined);
      notes.push({
        id: `dead-letters:${queue}`,
        tone: 'effect',
        note: attempts ? `dead-letters after ${attempts} ${attempts === 1 ? 'attempt' : 'attempts'}` : 'retries, then dead-letters',
        text: `${name(consumer)} can't finish its work, so ${name(queue)} redelivers and then sets the message aside, as drawn.${said}`,
        focus: [queue],
      });
      for (const route of deadLetters) {
        mark(route, 'recovery');
        const dlq = route.to;
        if (state.has(dlq)) continue;
        state.set(dlq, 'catching');
        const replay = analysis.interactions.some((next) => next.from === dlq && !!next.workload);
        notes.push(replay
          ? {
              id: `replay:${dlq}`,
              tone: 'shield',
              note: "replay from here once it's back",
              text: `Failed messages wait in ${name(dlq)}, and a replay route is drawn out of it.`,
              focus: [dlq],
            }
          : {
              id: `no-replay:${dlq}`,
              tone: 'question',
              note: 'messages stay here — no replay drawn',
              text: `Failed messages end up in ${name(dlq)}. Nothing drawn brings them back once ${targetName} recovers.`,
              focus: [dlq],
              ask: `How are messages in ${name(dlq)} replayed once ${targetName} is back?`,
              fix: { kind: 'replay', from: dlq, to: queue },
            });
      }
    }
  }

  // 3. Messaging that is down takes its producers' hand-off with it, and a dead-letter queue that
  //    is down leaves failures with nowhere to go. Neither has a drawn answer.
  for (const id of lost) {
    if (roleOf(id) !== 'messaging') continue;
    const fact = outageFact(drawn.get(id))?.down;
    const publishers = [...new Set((into.get(id) ?? []).filter((item) => item.class === 'publish' && !state.has(item.from)).map((item) => item.from))];
    for (const item of into.get(id) ?? []) if (item.class === 'publish') mark(item, 'failing');
    for (const publisher of publishers) state.set(publisher, 'degraded');
    if (publishers.length > 0) {
      notes.push({
        id: `cannot-publish:${publishers.join(',')}`,
        tone: 'question',
        note: "can't publish — then what?",
        text: `${listOf(publishers.map(name))} ${publishers.length === 1 ? 'hands' : 'hand'} work to ${name(id)}. Nothing drawn says what becomes of a message it can't accept.${fact ? ` ${fact}` : ''}`,
        focus: publishers,
        ask: `What does ${name(publishers[0]!)} do with a message it can't publish to ${name(id)}?`,
      });
    }
    const stranded = [...new Set(analysis.interactions.filter((item) => item.class === 'failure' && item.to === id && !down.has(item.from)).map((item) => item.from))];
    if (stranded.length > 0) {
      for (const item of analysis.interactions) if (item.class === 'failure' && item.to === id) mark(item, 'failing');
      notes.push({
        id: `nowhere:${stranded.join(',')}`,
        tone: 'question',
        note: 'failures have nowhere to go',
        text: `${listOf(stranded.map(name))} ${stranded.length === 1 ? 'sends' : 'send'} what fails to ${name(id)}.`,
        focus: stranded,
        ask: `Where do failed messages from ${name(stranded[0]!)} go while ${name(id)} is down?`,
      });
    }
  }

  // 4. Whatever work only reached through it goes quiet, and a store that is still read but no
  //    longer written goes stale.
  const reached = new Set<string>();
  const pending = analysis.entries.filter((id) => !down.has(id));
  for (let head = 0; head < pending.length; head += 1) {
    const at = pending[head]!;
    if (reached.has(at)) continue;
    reached.add(at);
    for (const item of outOf.get(at) ?? []) if (!down.has(item.to)) pending.push(item.to);
  }
  const quiet: string[] = [];
  for (const node of analysis.nodes.values()) {
    if (state.has(node.id) || !takesPart(node.id)) continue;
    if (reached.has(node.id)) state.set(node.id, 'unaffected');
    else {
      state.set(node.id, 'quiet');
      quiet.push(node.id);
    }
  }
  for (const item of baseline) {
    const from = state.get(item.from);
    if (from === 'down' || from === 'quiet') mark(item, 'stopped');
  }
  const silent = (id: string) => state.get(id) === 'down' || state.get(id) === 'quiet';
  for (const node of analysis.nodes.values()) {
    if (node.role !== 'data' || state.get(node.id) !== 'unaffected') continue;
    const arrivals = (into.get(node.id) ?? []).filter((item) => item.class === 'data');
    const writers = [...new Set(arrivals.filter(writes).map((item) => item.from))];
    const readers = [...new Set(arrivals.filter((item) => reads(item) && !silent(item.from)).map((item) => item.from))];
    if (writers.length === 0 || readers.length === 0 || !writers.every(silent)) continue;
    state.set(node.id, 'stale');
    notes.push({
      id: `stale:${node.id}`,
      tone: 'effect',
      note: 'goes stale',
      text: `${listOf(writers.map(name))} ${writers.length === 1 ? 'is' : 'are'} what ${writers.length === 1 ? 'writes' : 'write'} to ${name(node.id)}, so ${listOf(readers.map(name))} ${readers.length === 1 ? 'keeps' : 'keep'} reading what was there when ${outName} went down.`,
      focus: [node.id],
    });
  }
  if (quiet.length > 0) {
    const stores = quiet.every((id) => roleOf(id) === 'data');
    const scheduled = lost.length === 1 && categoryAt(lost[0]!) === 'scheduler';
    notes.push({
      id: `quiet:${quiet.join(',')}`,
      tone: 'effect',
      note: stores ? 'stops being updated' : scheduled ? 'never starts' : 'nothing arrives',
      text: `Everything that reaches ${listOf(quiet.map(name))} comes through ${outName}.`,
      focus: quiet.slice(0, 4),
    });
  }

  // 5. One instance drawn, and something depends on it.
  const affected = [...state.values()].filter((value) => value !== 'unaffected' && value !== 'down').length;
  if (lost.length === 1 && targetNode.type === 'service' && instanceCount === 1 && categoryAt(target.id) !== 'external' && affected > 0) {
    notes.push({
      id: `single:${target.id}`,
      tone: 'question',
      note: 'one instance drawn',
      text: `${targetName} is drawn as a single instance, so nothing takes over when it goes.`,
      focus: [target.id],
      ask: `Should ${targetName} run more than one instance?`,
      fix: { kind: 'instances', node: target.id },
    });
  }

  // Named in the order they were drawn, which is the order the diagram is read in.
  const unaffected = nodes.filter((node) => state.get(node.id) === 'unaffected').map((node) => node.id);
  const rest = unaffected.length === 0
    ? 'Nothing drawn carries on without it.'
    : affected === 0
      ? 'Nothing else drawn depends on it.'
      : `${listOf(unaffected.map(name), 2)} ${unaffected.length === 1 ? 'carries' : 'carry'} on.`;
  const subject = targetNode.type === 'group'
    ? `Everything in ${targetName} is down.`
    : instanceCount >= 2
      ? `All ${instanceCount} ${targetName} instances are down.`
      : `${targetName} is down.`;
  return finish(`${subject} ${rest}`);
}

/** The walk as plain sentences — what a screen reader hears, and what an agent is handed. */
export function outageSummary(outage: Outage): string[] {
  return [outage.headline, ...outage.notes.map((note) => (note.tone === 'question' && note.ask ? `${note.text} Open: ${note.ask}` : note.text))];
}

function group(items: readonly TrafficInteraction[], key: (item: TrafficInteraction) => string): Map<string, TrafficInteraction[]> {
  const map = new Map<string, TrafficInteraction[]>();
  for (const item of items) {
    const list = map.get(key(item));
    if (list) list.push(item);
    else map.set(key(item), [item]);
  }
  return map;
}

function listOf(names: string[], limit = 3): string {
  const shown = names.slice(0, limit);
  const rest = names.length - shown.length;
  if (rest > 0) return `${shown.join(', ')} and ${rest} more`;
  if (shown.length <= 1) return shown.join('');
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}
