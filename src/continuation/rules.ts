import type { EdgeSemantic } from '../document/types';
import type { ContinuationRule, Neighborhood } from './types';

/**
 * The V1 rules — four, on purpose. Each is something a developer would have drawn next anyway,
 * already has strong matrix semantics behind it, and depends on graph shape rather than a guess
 * about business intent. Anything from a plain Service, an Actor or a Data Store is deliberately
 * absent: too many valid next moves, so no one of them is *the* move.
 *
 * **Order is ranking.** Within a tier, an earlier rule outranks a later one; there are no scores.
 * The engine (`engine.ts`) applies the matrix, the generic suppressions and the tier gate — a rule
 * only says *when it applies* and *what it adds*, never whether the connection is legal.
 */

function hasOut(nb: Neighborhood, ...semantics: EdgeSemantic[]): boolean {
  return nb.out.some(({ edge }) => edge.semantic !== undefined && semantics.includes(edge.semantic));
}

/** A queue's delivery path: something is consuming from it or being delivered to. */
const DELIVERY: EdgeSemantic[] = ['consumes', 'deliversTo', 'fansOut'];

export const TOPIC_FAN_OUT_QUEUE: ContinuationRule = {
  id: 'topic-fan-out-queue',
  tier: 'primary',
  label: 'Queue',
  reason: 'This topic has a publisher but no delivery path.',
  when: (nb, trigger) =>
    nb.category === 'topic' && (trigger === 'drop' || (nb.in.length > 0 && !hasOut(nb, ...DELIVERY))),
  fragment: () => ({
    nodes: [{ key: 'queue', type: 'queue', queueKind: 'queue' }],
    edges: [{ from: 'anchor', to: 'queue' }],
  }),
  // A topic fans out: continuing from one that already feeds a queue means *another* queue.
  repeatable: (trigger) => trigger === 'drop',
};

export const TOPIC_FAN_OUT_WORKER: ContinuationRule = {
  id: 'topic-fan-out-worker',
  tier: 'secondary',
  label: 'Worker',
  reason: 'Subscribers can also receive directly from the topic.',
  when: TOPIC_FAN_OUT_QUEUE.when,
  fragment: () => ({
    nodes: [{ key: 'worker', type: 'service', serviceKind: 'worker' }],
    edges: [{ from: 'anchor', to: 'worker' }],
  }),
  repeatable: (trigger) => trigger === 'drop',
};

export const QUEUE_CONSUMER: ContinuationRule = {
  id: 'queue-consumer',
  tier: 'primary',
  label: 'Worker',
  reason: 'This queue has no consumer.',
  // `categoryOf` folds a Stream into `queue` (consuming from one is the same move) and lifts a
  // dead-letter queue out of it — a DLQ with no re-drive worker is normal, not unfinished.
  when: (nb, trigger) =>
    nb.category === 'queue' && (trigger === 'drop' || (nb.in.length > 0 && !hasOut(nb, ...DELIVERY))),
  fragment: () => ({
    nodes: [{ key: 'worker', type: 'service', serviceKind: 'worker' }],
    edges: [{ from: 'anchor', to: 'worker' }],
  }),
  // Competing consumers are what a queue is for.
  repeatable: (trigger) => trigger === 'drop',
};

export const QUEUE_DEAD_LETTER: ContinuationRule = {
  id: 'queue-dead-letter',
  tier: 'secondary',
  label: 'Dead-letter queue',
  reason: 'This queue has a consumer but no dead-letter path.',
  // The literal `queueKind === 'queue'`, not `categoryOf`, for the same reason `addDeadLetterQueue`
  // uses it: a Stream's dead-letter destination is a separate topic, not a queue-shaped DLQ.
  when: (nb) =>
    nb.node.type === 'queue' &&
    nb.node.queueKind === 'queue' &&
    nb.node.deliveryRole === undefined &&
    hasOut(nb, 'consumes') &&
    !hasOut(nb, 'deadLetters'),
  fragment: () => ({
    nodes: [{ key: 'dlq', type: 'queue', queueKind: 'queue', deliveryRole: 'dead-letter' }],
    // Three attempts is the conventional default — the one opinion `addDeadLetterQueue` has too.
    edges: [{ from: 'anchor', to: 'dlq', deliveryAttempts: 3 }],
  }),
};

export const GATEWAY_ROUTE: ContinuationRule = {
  id: 'gateway-route',
  tier: 'primary',
  label: 'Service',
  reason: "This gateway doesn't route to anything yet.",
  when: (nb, trigger) => nb.category === 'gateway' && (trigger === 'drop' || (nb.in.length > 0 && nb.out.length === 0)),
  fragment: () => ({
    nodes: [{ key: 'service', type: 'service', serviceKind: 'api' }],
    edges: [{ from: 'anchor', to: 'service' }],
  }),
  repeatable: (trigger) => trigger === 'drop',
};

export const RULES: readonly ContinuationRule[] = [
  TOPIC_FAN_OUT_QUEUE,
  TOPIC_FAN_OUT_WORKER,
  QUEUE_CONSUMER,
  QUEUE_DEAD_LETTER,
  GATEWAY_ROUTE,
];

export function ruleById(id: string): ContinuationRule | undefined {
  return RULES.find((rule) => rule.id === id);
}
