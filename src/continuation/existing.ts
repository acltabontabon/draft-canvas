import { capabilityFor, categoryOf, type NodeCategory } from '../document/connectorSemantics';
import { displayNameFor } from '../document/factory';
import type { DraftDocument, DraftNode, EdgeSemantic } from '../document/types';
import { ANCHOR_TYPES } from './context';
import type { Continuation, Neighborhood } from './types';

/** How close, edge to edge in flow units, a node must be to count as "right here". */
const NEARBY_GAP = 360;

/** Never more than this many connect-to-existing candidates for one anchor — nearest first. */
const MAX_CANDIDATES = 3;

/**
 * The verbs worth completing with something already drawn: each reads as the next word of an
 * architectural sentence ("Order Service *publishes* Order Events"). `calls` only from an Actor —
 * a Service calling whatever happens to be nearby is exactly the guess not to make. Reads,
 * searches, replication and the rest are left to the user.
 */
const CONNECTABLE: Partial<Record<EdgeSemantic, readonly NodeCategory[] | 'any'>> = {
  publishes: 'any',
  writes: 'any',
  fansOut: 'any',
  deliversTo: 'any',
  consumes: 'any',
  routes: 'any',
  triggers: 'any',
  calls: ['actor'],
};

/**
 * Suggestions to connect the anchor to a node already on the canvas instead of drawing another
 * one like it — "Order Service → the Order Events right next to it", not a second topic.
 *
 * Deliberately stricter than a rule's evidence, because being wrong here wires up the user's own
 * content. A node qualifies only when it is: an architecture shape; nearby (`NEARBY_GAP`); in the
 * same boundary as the anchor; not already connected to it either way, nor two hops away along
 * the flow in either direction (no loops, no shortcuts); a clean matrix pairing from the anchor whose default verb is `CONNECTABLE`; and
 * not already on the receiving end of that verb from someone else.
 *
 * Confidence is `high` (may ghost unprompted) only when, on top of that, the target has no
 * inbound connection at all, the anchor doesn't already do the same thing to the same kind of
 * node, the direction is not a coin toss, and either their names share a word ("Payment Service" /
 * "Payments DB") or it is the only such node around. A coin toss is two loose shapes that could
 * each continue into the other — a Service and a Topic side by side could be either "publishes"
 * or "delivers to" — until something already feeds the anchor (it is mid-sentence) or already
 * leaves the target (it is downstream-shaped). Otherwise `medium`: reachable by asking, never
 * pushed.
 *
 * One pass over the nodes and one over the edges; nothing else.
 */
export function existingTargetCandidates(doc: DraftDocument, nb: Neighborhood): Continuation[] {
  const anchor = nb.node;
  // Already part of this sentence: connected either way, or already reached two hops downstream
  // (a Topic's own subscriber's Worker is not a second thing to deliver to).
  const excluded = new Set<string>([anchor.id, ...nb.out.map((e) => e.other.id), ...nb.in.map((e) => e.other.id)]);
  for (const next of nb.outOfOut.values()) for (const e of next) excluded.add(e.other.id);
  const feeders = new Set(nb.in.map((e) => e.other.id));

  const eligible: Array<{ node: DraftNode; category: NodeCategory; semantic: EdgeSemantic; gap: number }> = [];
  for (const node of doc.nodes) {
    if (excluded.has(node.id) || !ANCHOR_TYPES.has(node.type)) continue;
    if ((node.parentId ?? null) !== (anchor.parentId ?? null)) continue;
    const gap = rectGap(anchor, node);
    if (gap > NEARBY_GAP) continue;
    const category = categoryOf(node);
    const capability = capabilityFor(nb.category, category);
    const semantic = capability?.defaultRelation;
    if (!semantic || (capability.status ?? 'valid') !== 'valid' || !connectable(semantic, nb.category)) continue;
    eligible.push({ node, category, semantic, gap });
  }
  if (eligible.length === 0) return [];

  const byId = new Map(eligible.map((e) => [e.node.id, { ...e, inbound: 0, inboundSame: 0, outbound: 0, upstream: false }]));
  for (const edge of doc.edges) {
    const target = byId.get(edge.target);
    if (target) {
      target.inbound += 1;
      if (edge.semantic === target.semantic) target.inboundSame += 1;
    }
    const source = byId.get(edge.source);
    if (source) {
      source.outbound += 1;
      // Two hops up: something feeding the anchor's own feeders would close a loop.
      if (feeders.has(edge.target)) source.upstream = true;
    }
  }

  const open = [...byId.values()]
    .filter((e) => e.inboundSame === 0 && !e.upstream)
    .sort((a, b) => a.gap - b.gap || a.node.id.localeCompare(b.node.id))
    .slice(0, MAX_CANDIDATES);
  const anchorWords = wordsOf(anchor.text);

  return open.map(({ node, category, semantic, inbound, outbound }) => {
    const affinity = anchorWords.size > 0 && [...wordsOf(node.text)].some((word) => anchorWords.has(word));
    const alreadyDoesThis = nb.out.some((out) => out.edge.semantic === semantic && out.category === category);
    const coinToss = nb.in.length === 0 && outbound === 0 && continuesInto(category, nb.category);
    const high = inbound === 0 && !alreadyDoesThis && !coinToss && (affinity || open.length === 1);
    const name = displayNameFor(node);
    return {
      id: `connect-existing:${node.id}`,
      ruleId: 'connect-existing',
      tier: high ? 'primary' : 'secondary',
      confidence: high ? 'high' : 'medium',
      score: 0,
      // The pill must not read like a new node called that: it says what happens.
      label: `Connect to ${name}`,
      actionLabel: `Connect to ${name}`,
      reason: inbound === 0 ? `${name} is right here and not connected to anything yet.` : `${name} is right here.`,
      fragment: { nodes: [], edges: [{ from: 'anchor', to: 'target' }], existing: [{ key: 'target', nodeId: node.id }] },
      anchorId: anchor.id,
      neighborhoodKey: nb.key,
    } satisfies Continuation;
  });
}

/** Whether `from` could just as well continue into `to` — the reverse reading of a pairing. */
function continuesInto(from: NodeCategory, to: NodeCategory): boolean {
  const capability = capabilityFor(from, to);
  const semantic = capability?.defaultRelation;
  return semantic !== undefined && (capability?.status ?? 'valid') === 'valid' && connectable(semantic, from);
}

function connectable(semantic: EdgeSemantic, source: NodeCategory): boolean {
  const sources = CONNECTABLE[semantic];
  return sources === 'any' || (sources?.includes(source) ?? false);
}

/** Edge-to-edge distance between two boxes; 0 when they touch or overlap. */
function rectGap(a: Pick<DraftNode, 'x' | 'y' | 'width' | 'height'>, b: Pick<DraftNode, 'x' | 'y' | 'width' | 'height'>): number {
  const dx = Math.max(0, a.x - (b.x + b.width), b.x - (a.x + a.width));
  const dy = Math.max(0, a.y - (b.y + b.height), b.y - (a.y + a.height));
  return Math.hypot(dx, dy);
}

/**
 * The words in a label that say *what* it is about, not *which kind* of box it is: "Payments DB"
 * and "Payment Service" share "payment"; "Order Service" and "Billing Service" share nothing.
 */
function wordsOf(text: string | undefined): Set<string> {
  const words = new Set<string>();
  for (const raw of (text ?? '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue;
    // Singular first, so "Streams" is filtered as the kind word it is, not kept as a shared name.
    const word = raw.endsWith('ies') ? `${raw.slice(0, -3)}y` : raw.endsWith('s') && !raw.endsWith('ss') ? raw.slice(0, -1) : raw;
    if (KIND_WORDS.has(word)) continue;
    words.add(word);
  }
  return words;
}

const KIND_WORDS: ReadonlySet<string> = new Set([
  'api',
  'app',
  'bucket',
  'bus',
  'cache',
  'component',
  'consumer',
  'data',
  'database',
  'event',
  'events',
  'external',
  'gateway',
  'handler',
  'index',
  'job',
  'jobs',
  'module',
  'port',
  'producer',
  'queue',
  'queues',
  'scheduler',
  'search',
  'service',
  'services',
  'storage',
  'store',
  'stream',
  'svc',
  'system',
  'table',
  'the',
  'topic',
  'topics',
  'user',
  'worker',
  'workers',
]);
