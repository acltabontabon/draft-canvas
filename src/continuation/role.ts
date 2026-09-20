import type { NodeCategory } from '../document/connectorSemantics';
import type { Neighborhood } from './types';

/**
 * What an anchor is evidently *doing*, read only from what points at it.
 *
 * A Service is the most-drawn shape and the least self-describing one: the same box is a request
 * handler behind a gateway, a consumer draining a queue, or a job a scheduler wakes up, and the
 * next thing you'd draw is different in each. Nothing on the node itself says which — but its
 * inbound connectors do, and they are already in the neighborhood.
 *
 * This is a reading of graph shape, not a guess about intent: no node is relabelled, no semantics
 * change, and a role never adds or removes a candidate. It only reorders what asking already
 * offers (`rank.ts`), so being wrong costs a press of `]` and nothing else.
 */
export type AnchorRole = 'consumer' | 'scheduled' | 'request' | 'plain';

/** Inbound categories that give a role away, most-informative first. */
const ROLE_EVIDENCE: readonly (readonly [AnchorRole, readonly NodeCategory[]])[] = [
  // Work arrives on its own schedule. The most specific thing that can point at a service, so it
  // wins: a consumer that also sits behind a gateway is still a consumer.
  ['consumer', ['queue', 'topic', 'deadLetter']],
  ['scheduled', ['scheduler']],
  // Someone is waiting for an answer.
  ['request', ['gateway', 'actor']],
];

/** The anchor's role, from its inbound connectors alone. Nothing pointing at it yet: `plain`. */
export function anchorRole(nb: Neighborhood): AnchorRole {
  for (const [role, categories] of ROLE_EVIDENCE) {
    if (nb.in.some(({ category }) => categories.includes(category))) return role;
  }
  return 'plain';
}

/**
 * How much each role argues for a candidate, by rule id — hand-written, like every reason in
 * `rules.ts`, and for the same reason: which of several legal moves is the *likely* one is a
 * judgement, not something the capability matrix knows. Small integers, read against `rank.ts`'s
 * other signals.
 *
 * Only the `service-*` rules appear: a Topic or a Queue has one obvious next move already, and the
 * rules for those say so themselves. An id missing from a row scores nothing and keeps its
 * authored place.
 */
export const ROLE_PREFERENCE: Readonly<Record<AnchorRole, Readonly<Record<string, number>>>> = {
  // Behind a gateway, or called by a person: its own data first, then what keeps those reads fast,
  // then whoever else it has to call to answer.
  request: { 'service-data-store': 3, 'service-cache': 2, 'service-service': 1 },
  // Fed by a queue or a topic: where the result lands, what it announces once it's done, and who
  // outside it has to tell.
  consumer: { 'service-data-store': 3, 'service-topic': 2, 'service-external': 1 },
  // Woken by a scheduler: a batch job writes what it produced, then reaches the systems it syncs
  // with and the index it refreshes.
  scheduled: { 'service-data-store': 3, 'service-external': 2, 'service-search-index': 1 },
  // Nothing points at it yet, so there is nothing to read. The authored order stands.
  plain: {},
};
