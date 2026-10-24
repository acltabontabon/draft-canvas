/**
 * Semantic review: what a pattern in one view is missing, read from the diagram's own semantics — a
 * queue with consumers and no dead-letter path, a dead-letter queue fed by something other than the
 * queue whose messages it parks, a cache nothing fills, a database two services write.
 * The same findings serve the agent (`read_diagram`'s `review`, the receipts' advisories) and the
 * person (the desktop companion can say them in its own voice), so they are plain data: a code, the
 * ids involved, and a factual sentence naming the parts by label.
 *
 * Silence over guesses. A finding is only made when the model says it: a connector's semantic counts
 * when the author chose it, or when it is the inferred default *and* nothing else is written on the
 * connector (then the canvas shows that very word). A labelled connector whose semantic was only
 * inferred says what its label says, which this module can't read — so it is "unknown", and an
 * unknown connector silences every finding about something being *absent* at its ends. Junctions and
 * boundaries hide what lies behind them, and silence the same way.
 *
 * Pure and deterministic, with no React, store or DOM: it runs on the agent worker with `read.ts`.
 */

import { categoryOf, type NodeCategory } from '../document/connectorSemantics';
import { MESSAGING_CATEGORIES, STORE_CATEGORIES } from '../document/edgeSemantics';
import type { DraftDocument, DraftEdge, DraftNode, EdgeSemantic, ViewLevel } from '../document/types';
import { effectiveLevel } from '../depth/level';
import { roomsOf } from '../depth/tree';

export type ReviewCode =
  | 'call-cycle'
  | 'shared-database'
  | 'no-consumer'
  | 'no-dead-letter'
  | 'dead-letter-source'
  | 'no-producer'
  | 'cache-not-written'
  | 'unconnected';

export interface ReviewFinding {
  code: ReviewCode;
  /** The parts involved, the one the finding is about first. */
  ids: string[];
  /** One factual sentence naming the parts by label. Built from the person's text: data, not advice. */
  message: string;
}

export interface ReviewOptions {
  /** The view's C4 level. A context view leaves messaging and caching detail to the levels below. */
  level?: ViewLevel | null;
  /** An inside view: what its parts exchange with the outside is drawn a level up, so "nothing sends
   *  to it" or "connected to nothing" can't be told from here. */
  nested?: boolean;
  /** At most this many findings (default `REVIEW_LIMIT`). */
  limit?: number;
}

export const REVIEW_LIMIT = 8;

/** Most important first: the order findings are listed in, and cut in. */
const ORDER: readonly ReviewCode[] = ['call-cycle', 'shared-database', 'no-consumer', 'no-dead-letter', 'dead-letter-source', 'no-producer', 'cache-not-written', 'unconnected'];

/** Shapes that do something — call, publish, consume, read, write. */
const ACTING: ReadonlySet<NodeCategory> = new Set(['actor', 'agent', 'device', 'service', 'external', 'worker', 'scheduler', 'gateway', 'component', 'port']);
/** Deployable services, the ones a shared database couples. Components share a process. */
const DEPLOYABLE: ReadonlySet<NodeCategory> = new Set(['service', 'worker', 'scheduler']);
const CALLERS: ReadonlySet<NodeCategory> = new Set(['service', 'external', 'worker', 'scheduler', 'gateway', 'component']);
const CALLS: ReadonlySet<EdgeSemantic> = new Set(['calls', 'http', 'grpc', 'query', 'uses', 'dependsOn']);
/** Behaviours that make a connector something other than a call: a callback answers one. */
const NOT_A_CALL = new Set(['async', 'event', 'callback', 'failure', 'fallback']);
/** What an acting shape does when its arrow points at a queue, topic or stream and it is sending. */
const SENDS: ReadonlySet<EdgeSemantic> = new Set(['publishes', 'command', 'event', 'compensates', 'notifies', 'triggers', 'writes', 'fansOut', 'deliversTo', 'routes', 'ingests']);
const WRITES: ReadonlySet<EdgeSemantic> = new Set(['writes', 'readsWrites']);
const FILLS_CACHE: ReadonlySet<EdgeSemantic> = new Set(['writes', 'readsWrites', 'invalidates']);
const READS_CACHE: ReadonlySet<EdgeSemantic> = new Set(['reads', 'query', 'searches']);
/** What a connector toward a dead-letter queue says when it reads from it rather than feeding it. */
const NOT_FEEDING: ReadonlySet<EdgeSemantic> = new Set(['consumes', 'reads', 'query', 'searches', 'dependsOn']);
const ARCHITECTURE = new Set<DraftNode['type']>(['service', 'database', 'queue', 'actor', 'component']);
/** A queue named as a dead-letter or retry queue is one, whatever kind it was given. */
const DEAD_LETTER_NAME = /\b(dlq|dead[\s-]?letters?|poison|parking[\s-]?lot)\b/i;
const RETRY_NAME = /\bretr(y|ies)\b/i;

/** The semantic a connector states, or nothing when it can't be told (see the module comment). */
export function statedSemantic(edge: DraftEdge): EdgeSemantic | undefined {
  if (!edge.semantic) return undefined;
  return edge.semanticsOrigin !== 'inferred' || !edge.label?.trim() ? edge.semantic : undefined;
}

export function reviewView(nodes: readonly DraftNode[], edges: readonly DraftEdge[], options: ReviewOptions = {}): ReviewFinding[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const category = new Map(nodes.map((n) => [n.id, categoryOf(n)]));
  const live = edges.filter((e) => e.source !== e.target && byId.has(e.source) && byId.has(e.target));
  const touching = new Map<string, DraftEdge[]>();
  for (const edge of live) {
    for (const end of [edge.source, edge.target]) {
      const list = touching.get(end);
      if (list) list.push(edge);
      else touching.set(end, [edge]);
    }
  }
  const at = (id: string) => touching.get(id) ?? [];
  const cat = (id: string) => category.get(id)!;
  const name = (id: string) => nameOf(byId.get(id)!, cat(id));
  /** "Queue "Orders"", or "An unnamed queue" — the subject a sentence starts with. */
  const titled = (kind: string, id: string) => (byId.get(id)!.text?.trim() ? `${upper(kind)} ${name(id)}` : upper(name(id)));
  const isDeadLetter = (id: string) => cat(id) === 'deadLetter' || (MESSAGING_CATEGORIES.has(cat(id)) && DEAD_LETTER_NAME.test(byId.get(id)!.text ?? ''));
  /** Whether a shape has somewhere to park what it can't process. */
  const parks = (id: string) =>
    at(id).some((e) => e.source === id && (isDeadLetter(e.target) || e.semantic === 'deadLetters' || (e.kind === 'failure' && (MESSAGING_CATEGORIES.has(cat(e.target)) || STORE_CATEGORIES.has(cat(e.target))))));
  const detail = options.level !== 'context';
  const found: ReviewFinding[] = [];

  for (const node of nodes) {
    const c = cat(node.id);

    if (detail && (c === 'queue' || c === 'topic' || c === 'stream')) {
      const own = at(node.id);
      // A dead-letter queue by its name or by what feeds it: having no consumer is normal for one.
      const isItselfDeadLetter = DEAD_LETTER_NAME.test(node.text ?? '') || own.some((e) => e.target === node.id && e.semantic === 'deadLetters');
      if (isItselfDeadLetter) continue;
      const producers = new Set<string>();
      const consumers = new Set<string>();
      let unknown = false;
      let opaque = false;
      let deadLetterLinked = false;
      for (const edge of own) {
        const outbound = edge.source === node.id;
        const other = outbound ? edge.target : edge.source;
        const oc = cat(other);
        if (isDeadLetter(other) || edge.semantic === 'deadLetters') {
          deadLetterLinked = true;
          if (!outbound) producers.add(other); // a re-drive back into the queue
          continue;
        }
        const known = ACTING.has(oc) || STORE_CATEGORIES.has(oc) || MESSAGING_CATEGORIES.has(oc);
        if (!known) opaque = true;
        // A line with no arrow says nothing about which way messages go.
        if (edge.directed === false) { unknown = true; continue; }
        const stated = statedSemantic(edge);
        if (outbound) {
          // Whatever a queue's arrow points at, it hands messages to.
          if (stated === 'dependsOn') unknown = true;
          else consumers.add(other);
        } else if (!known) {
          unknown = true;
        } else if (!ACTING.has(oc)) {
          producers.add(other); // a store or another channel feeding it
        } else if (stated === 'consumes') {
          consumers.add(other);
        } else if (stated && SENDS.has(stated)) {
          producers.add(other);
        } else {
          unknown = true;
        }
      }
      const kind: string = c;
      if (!unknown && producers.size > 0 && consumers.size === 0) {
        found.push({
          code: 'no-consumer',
          ids: [node.id, ...producers],
          message: `${titled(kind, node.id)} receives messages from ${list([...producers].map(name))}, but nothing consumes them.`,
        });
      }
      // Queues only: a stream or topic is often where a pipeline begins, fed from outside the diagram
      // (change data capture, ingestion), and flagging every such entry point was noise.
      if (!unknown && !options.nested && c === 'queue' && consumers.size > 0 && producers.size === 0) {
        found.push({
          code: 'no-producer',
          ids: [node.id, ...consumers],
          message: `${titled(kind, node.id)} is consumed by ${list([...consumers].map(name))}, but nothing in this view sends messages to it.`,
        });
      }
      // A topic never dead-letters (each subscriber's own queue does), and a stream keeps every record:
      // its consumers park what they can't process. Only a queue's own path, or its consumers', counts.
      if (!opaque && !deadLetterLinked && consumers.size > 0) {
        const neighbours = new Set(own.map((e) => (e.source === node.id ? e.target : e.source)).filter((id) => ACTING.has(cat(id))));
        if (c === 'queue' && !RETRY_NAME.test(node.text ?? '') && ![...neighbours].some(parks)) {
          found.push({
            code: 'no-dead-letter',
            ids: [node.id, ...consumers],
            message: `${titled('queue', node.id)} has ${consumers.size === 1 ? 'a consumer' : 'consumers'} (${list([...consumers].map(name))}) but no dead-letter path: a message that keeps failing has nowhere to go.`,
          });
        }
        if (c === 'stream') {
          const stranded = [...consumers].filter((id) => ACTING.has(cat(id)) && !parks(id));
          if (stranded.length) {
            found.push({
              code: 'no-dead-letter',
              ids: [node.id, ...stranded],
              message: `${list(stranded.map(name))} ${stranded.length === 1 ? 'reads' : 'read'} stream ${name(node.id)} but ${stranded.length === 1 ? 'has' : 'have'} no dead-letter path for a record ${stranded.length === 1 ? 'it' : 'they'} can't process.`,
            });
          }
        }
      }
    }

    if (detail && c === 'cache') {
      const readers = new Set<string>();
      let fills = false;
      let unknown = false;
      for (const edge of at(node.id)) {
        const outbound = edge.source === node.id;
        const other = outbound ? edge.target : edge.source;
        // A store or a channel beside a cache may well be what refreshes it — say nothing.
        if (!ACTING.has(cat(other)) || edge.directed === false) { unknown = true; continue; }
        const stated = statedSemantic(edge);
        if (outbound) {
          if (stated === 'reads') readers.add(other);
          else unknown = true;
        } else if (stated && FILLS_CACHE.has(stated)) {
          fills = true;
        } else if (stated && READS_CACHE.has(stated)) {
          readers.add(other);
        } else {
          unknown = true;
        }
      }
      if (!unknown && !fills && readers.size > 0) {
        found.push({
          code: 'cache-not-written',
          ids: [node.id, ...readers],
          message: `${titled('cache', node.id)} is read by ${list([...readers].map(name))}, but nothing writes to, refreshes or invalidates it.`,
        });
      }
    }

    if (c === 'database') {
      const writers = new Set<string>();
      for (const edge of at(node.id)) {
        const other = edge.source === node.id ? edge.target : edge.source;
        const stated = statedSemantic(edge);
        if (DEPLOYABLE.has(cat(other)) && stated && WRITES.has(stated)) writers.add(other);
      }
      if (writers.size >= 2) {
        found.push({
          code: 'shared-database',
          ids: [node.id, ...writers],
          message: `${titled('database', node.id)} has no single owner: ${list([...writers].map(name))} ${writers.size === 2 ? 'both' : 'all'} write to it.`,
        });
      }
    }
  }

  // A dead-letter queue fed by something other than a queue. Dead-lettering is the queue's job: the
  // broker moves a message off the queue its consumer keeps rejecting (an SQS redrive policy, a
  // RabbitMQ dead-letter exchange, a Service Bus subqueue). A topic fans out and keeps nothing to
  // redrive, and a consumer writing to the DLQ itself hides the queue that should own the path —
  // except a stream's consumer, which parks what it can't process by design (a stream keeps every
  // record). Only what the view shows: a consumer whose input isn't drawn here (an inside view, a
  // junction in the way) could be reading a stream. A queue that is a dead-letter queue only by its
  // name counts only when the connector says it dead-letters (or fails) into it.
  if (detail) {
    for (const edge of live) {
      if (edge.directed === false || !isDeadLetter(edge.target) || isDeadLetter(edge.source)) continue;
      if (cat(edge.target) !== 'deadLetter' && edge.semantic !== 'deadLetters' && edge.kind !== 'failure') continue;
      const stated = statedSemantic(edge);
      if (stated && NOT_FEEDING.has(stated)) continue;
      const source = edge.source;
      const dlq = edge.target;
      const sc = cat(source);
      const into = `${name(source)} feeds dead-letter queue ${name(dlq)}`;
      if (sc === 'topic') {
        found.push({
          code: 'dead-letter-source',
          ids: [dlq, source],
          message: `${titled('topic', source)} feeds dead-letter queue ${name(dlq)}, but a topic doesn't dead-letter: it fans each message out and keeps none. Give each subscriber its own queue between the topic and its consumer, and dead-letter from that queue.`,
        });
        continue;
      }
      if (sc === 'stream') {
        found.push({
          code: 'dead-letter-source',
          ids: [dlq, source],
          message: `${titled('stream', source)} feeds dead-letter queue ${name(dlq)}, but a stream doesn't dead-letter: it keeps every record. Draw the path from the consumer that can't process a record.`,
        });
        continue;
      }
      if (!ACTING.has(sc)) continue;
      // What the consumer reads: a channel pointing at it, or one it is drawn consuming from.
      const queues: string[] = [];
      const topics: string[] = [];
      let stream = false;
      let hidden = false;
      for (const other of at(source)) {
        if (other === edge) continue;
        const end = other.source === source ? other.target : other.source;
        const ec = cat(end);
        if (ec === 'junction' || ec === 'generic') hidden = true;
        if (isDeadLetter(end) || !MESSAGING_CATEGORIES.has(ec) || other.directed === false) continue;
        const reads = other.target === source || statedSemantic(other) === 'consumes';
        if (!reads) continue;
        if (ec === 'stream') stream = true;
        else if (ec === 'topic') topics.push(end);
        else if (ec === 'queue') queues.push(end);
      }
      if (stream) continue;
      if (queues.length) {
        found.push({
          code: 'dead-letter-source',
          ids: [dlq, source, ...queues],
          message: `${into} itself, but dead-lettering is the queue's job: connect ${name(dlq)} from ${queues.length === 1 ? 'queue' : 'queues'} ${list(queues.map(name), 3, 'or')}, whose messages ${name(source)} rejects — the broker moves a message there once its delivery attempts run out.`,
        });
      } else if (topics.length) {
        found.push({
          code: 'dead-letter-source',
          ids: [dlq, source, ...topics],
          message: `${into} itself, but a dead-letter queue takes messages from the queue that rejects them: model ${name(source)}'s own queue between ${topics.length === 1 ? 'topic' : 'topics'} ${list(topics.map(name))} and ${name(source)}, and dead-letter from that queue.`,
        });
      } else if (!hidden && !options.nested) {
        found.push({
          code: 'dead-letter-source',
          ids: [dlq, source],
          message: `${into} itself, but a dead-letter queue takes messages from the queue that rejects them: model the queue ${name(source)} consumes from, and dead-letter from that queue.`,
        });
      }
    }
  }

  // Two services calling each other, each by a plain call (a callback or an event back is not one).
  const isCall = (e: DraftEdge) => {
    const stated = statedSemantic(e);
    return e.directed !== false && !e.async && !(e.kind && NOT_A_CALL.has(e.kind)) && !!stated && CALLS.has(stated) && CALLERS.has(cat(e.source)) && CALLERS.has(cat(e.target));
  };
  const calls = new Map<string, DraftEdge>();
  for (const edge of live) if (isCall(edge) && !calls.has(`${edge.source}>${edge.target}`)) calls.set(`${edge.source}>${edge.target}`, edge);
  const paired = new Set<string>();
  for (const there of calls.values()) {
    const back = calls.get(`${there.target}>${there.source}`);
    const pair = [there.source, there.target].sort().join('|');
    if (!back || paired.has(pair)) continue;
    paired.add(pair);
    found.push({
      code: 'call-cycle',
      ids: [there.source, there.target, there.id, back.id],
      message: `${name(there.source)} and ${name(there.target)} call each other: a call cycle, so neither can change or fail on its own.`,
    });
  }

  // Shapes connected to nothing — only in a view that has connections at all (a view of bare shapes
  // is an inventory, not an unfinished pattern) and not inside a view (its links are a level up).
  if (!options.nested && live.length) {
    const architecture = nodes.filter((n) => ARCHITECTURE.has(n.type));
    const linked = (node: DraftNode) => {
      const seen = new Set<string>();
      for (let id: string | undefined = node.id; id && !seen.has(id); id = byId.get(id)?.parentId) {
        seen.add(id);
        if (at(id).length) return true;
      }
      return false;
    };
    const alone = architecture.length >= 2 ? architecture.filter((n) => !linked(n)) : [];
    if (alone.length) {
      found.push({
        code: 'unconnected',
        ids: alone.map((n) => n.id),
        message: `${list(alone.map((n) => name(n.id)))} ${alone.length === 1 ? 'has' : 'have'} no connections in this view.`,
      });
    }
  }

  return found
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => ORDER.indexOf(a.finding.code) - ORDER.indexOf(b.finding.code) || a.index - b.index)
    .slice(0, Math.max(0, options.limit ?? REVIEW_LIMIT))
    .map(({ finding }) => ({ ...finding, message: upper(finding.message) }));
}

/** Every view of a file reviewed, the top one first; a finding inside a view says which (`view`, the
 *  element ids leading down to it, as `read_diagram`'s `view.inside` takes them). */
export function reviewFile(file: DraftDocument, limit = REVIEW_LIMIT): (ReviewFinding & { view?: string[] })[] {
  const out: (ReviewFinding & { view?: string[] })[] = [];
  for (const room of roomsOf(file)) {
    if (out.length >= limit) break;
    const nested = room.path.length > 0;
    for (const finding of reviewView(room.graph.nodes, room.graph.edges, { level: effectiveLevel(file, room.path), nested, limit: limit - out.length })) {
      out.push(nested ? { ...finding, view: [...room.path] } : finding);
    }
  }
  return out;
}

/** The findings a change brought in: each one naming a part the same finding didn't name before. */
export function newFindings(before: readonly ReviewFinding[], after: readonly ReviewFinding[]): ReviewFinding[] {
  const seen = new Map<ReviewCode, Set<string>>();
  for (const finding of before) {
    const ids = seen.get(finding.code) ?? new Set<string>();
    for (const id of finding.ids) ids.add(id);
    seen.set(finding.code, ids);
  }
  return after.filter((finding) => finding.ids.some((id) => !seen.get(finding.code)?.has(id)));
}

const KIND_WORDS: Partial<Record<NodeCategory, string>> = {
  deadLetter: 'dead-letter queue',
  fileSystem: 'file system',
  objectStorage: 'object storage',
  searchIndex: 'search index',
  external: 'external system',
  junction: 'junction',
};

/** A part by its label, quoted; one without a label by what it is. */
function nameOf(node: DraftNode, category: NodeCategory): string {
  const label = node.text?.split('\n')[0]?.trim();
  if (label) return `"${label.length > 60 ? `${label.slice(0, 59)}…` : label}"`;
  return `an unnamed ${KIND_WORDS[category] ?? (category === 'generic' ? node.type : category)}`;
}

const upper = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/** "a", "a and b", "a, b and c", "a, b, c and 2 more" — or "a or b" when only one of them is meant. */
function list(names: readonly string[], max = 3, joiner: 'and' | 'or' = 'and'): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length > max) return `${names.slice(0, max).join(', ')} ${joiner} ${names.length - max} more`;
  return `${names.slice(0, -1).join(', ')} ${joiner} ${names[names.length - 1]}`;
}
