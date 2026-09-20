import { capabilityFor, categoryOf, type NodeCategory } from '../document/connectorSemantics';
import { ROLE_PREFERENCE, anchorRole } from './role';
import type { Continuation, FragmentNodeSpec, Neighborhood } from './types';

/**
 * What a ranking signal may look at: the anchor's neighborhood and the session's recently accepted
 * rule ids (passed in by the caller, so ranking stays a pure function of its inputs).
 */
export interface RankingContext {
  nb: Neighborhood;
  recent: readonly string[];
}

/**
 * One reason to move a candidate up or down among its siblings. Each returns a small integer and
 * reads like a sentence; together they are the whole ranking model — no weights table, no
 * learning, no hidden state. A signal never changes confidence: it only reorders.
 */
export type RankingSignal = (candidate: Continuation, context: RankingContext) => number;

/**
 * "The anchor already has a branch shaped exactly like this one." Where fanning out is the point
 * (`branches`), the likeliest next move is another sibling of the same shape — the longer the
 * matching shape, the stronger the hint, so a Topic with a `Queue → Worker` subscriber puts
 * another `Queue → Worker` ahead of a bare Queue.
 */
const siblingBranch: RankingSignal = (candidate, { nb }) => {
  if (!candidate.branches) return 0;
  const chain = chainFromAnchor(candidate);
  if (chain.length === 0) return 0;
  const matches = nb.out.some(({ other, category }) => {
    if (!sameKind(category, chain[0]!)) return false;
    if (chain.length === 1) return true;
    return (nb.outOfOut.get(other.id) ?? []).some((next) => sameKind(next.category, chain[1]!));
  });
  return matches ? 1 + Math.min(chain.length, 2) : 0;
};

/**
 * "The anchor already does exactly this." Another consumer on a queue that has one, another
 * database for a service already writing to one — legal, occasionally right, rarely the most
 * useful next word. Fan-out rules are exempt: a second sibling is what they are for.
 */
const repeatsExisting: RankingSignal = (candidate, { nb }) => {
  if (candidate.branches) return 0;
  const step = candidate.fragment.edges.find((edge) => edge.from === 'anchor');
  const spec = step && candidate.fragment.nodes.find((node) => node.key === step.to);
  if (!spec) return 0;
  const category = categoryOf(spec);
  const semantic = capabilityFor(nb.category, category)?.defaultRelation;
  const repeated = nb.out.some((out) => out.edge.semantic === semantic && sameKind(out.category, category));
  return repeated ? -2 : 0;
};

/**
 * "This is what a shape in that position usually needs next." The same Service is a different
 * thing behind a gateway, on the end of a queue, or woken by a scheduler (`role.ts`), and the
 * authored order can only be right for one of them — so the anchor's role picks which of its own
 * alternatives to lead with. It never adds a candidate, and it never overrules the signal below:
 * a shape the anchor already draws stays where that put it.
 */
const fitsNeighborhood: RankingSignal = (candidate, context) => {
  if (repeatsExisting(candidate, context) < 0) return 0;
  return ROLE_PREFERENCE[anchorRole(context.nb)][candidate.ruleId] ?? 0;
};

/** "You have been adding this kind of thing." A nudge among the optional candidates, nothing more. */
const recentlyAccepted: RankingSignal = (candidate, { recent }) =>
  candidate.confidence === 'medium' && recent.includes(candidate.ruleId) ? 1 : 0;

/**
 * "It is already on the canvas." Connecting to a suitable existing node beats creating a
 * look-alike next to it, when both are equally justified.
 */
const alreadyDrawn: RankingSignal = (candidate) => ((candidate.fragment.existing?.length ?? 0) > 0 ? 1 : 0);

const SIGNALS: readonly RankingSignal[] = [
  siblingBranch,
  repeatsExisting,
  fitsNeighborhood,
  recentlyAccepted,
  alreadyDrawn,
];

/**
 * Best first. Confidence always dominates — a medium candidate never outranks a high one, whatever
 * its score — then the signals' score, then the authored tier, then generation order (stable), so
 * with no signal firing the order is exactly the authored one.
 */
export function rank(
  candidates: readonly Continuation[],
  context: RankingContext,
  signals: readonly RankingSignal[] = SIGNALS,
): Continuation[] {
  return candidates
    .map((candidate, index) => ({
      candidate: { ...candidate, score: signals.reduce((sum, signal) => sum + signal(candidate, context), 0) },
      index,
    }))
    .sort(
      (a, b) =>
        confidenceRank(a.candidate) - confidenceRank(b.candidate) ||
        b.candidate.score - a.candidate.score ||
        tierRank(a.candidate) - tierRank(b.candidate) ||
        a.index - b.index,
    )
    .map(({ candidate }) => candidate);
}

const confidenceRank = (c: Continuation) => (c.confidence === 'high' ? 0 : 1);
const tierRank = (c: Continuation) => (c.tier === 'primary' ? 0 : 1);

/** The categories a fragment's new nodes form, following its connectors out from the anchor. */
function chainFromAnchor(candidate: Continuation): NodeCategory[] {
  const { nodes, edges } = candidate.fragment;
  const chain: NodeCategory[] = [];
  let from = 'anchor';
  for (let i = 0; i < nodes.length; i++) {
    const step = edges.find((edge) => edge.from === from);
    const spec: FragmentNodeSpec | undefined = step && nodes.find((node) => node.key === step.to);
    if (!spec) break;
    chain.push(categoryOf(spec));
    from = spec.key;
  }
  return chain;
}

/** Same kind of thing for ranking purposes: a Worker and a plain Service consume a queue alike. */
function sameKind(a: NodeCategory, b: NodeCategory): boolean {
  return a === b || (RUNTIME.has(a) && RUNTIME.has(b));
}

const RUNTIME: ReadonlySet<NodeCategory> = new Set<NodeCategory>(['service', 'worker']);
