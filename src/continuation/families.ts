import type { NodeCategory } from '../document/connectorSemantics';
import type { EdgeSemantic } from '../document/types';
import type { ContinuationRule, ContinuationTier, ContinuationTrigger, FragmentNodeSpec, Neighborhood } from './types';

/**
 * Reusable pieces for authoring new continuation rules that reuse the graph-shape reasoning the
 * original five rules already applied by hand, instead of repeating it per node kind.
 *
 * This module is deliberately small and deliberately NOT a generator that walks the capability
 * matrix and invents a rule for every legal pairing. Legality (the matrix, enforced by
 * `engine.ts`'s `fragmentIsValid`) and "worth suggesting" (evidence — is there real graph shape
 * backing this, not just a theoretical connection) are different questions; only a person can
 * answer the second one. Every family below is still called with a hand-chosen source category
 * list, a hand-chosen evidence check, and hand-authored target reasons — see `rules.ts` for the
 * specific matrix rows each call is justified against. Do not "improve" this into something that
 * iterates `NodeCategory` pairs on its own.
 */

/** The user asked (a `]` or a dropped connector) rather than merely selected — evidence a quiet
 *  suggestion would need is no longer required. */
export function isExplicit(trigger: ContinuationTrigger): boolean {
  return trigger !== 'select';
}

/** An outgoing connector from the anchor whose semantic is any of `semantics` — "has this already
 *  happened." */
export function hasOutboundSemantic(nb: Neighborhood, ...semantics: EdgeSemantic[]): boolean {
  return nb.out.some(({ edge }) => edge.semantic !== undefined && semantics.includes(edge.semantic));
}

/** At least one connector already points at the anchor — real evidence something is happening
 *  here, not just a shape that could theoretically continue. */
export function hasInboundEvidence(nb: Neighborhood): boolean {
  return nb.in.length > 0;
}

/** A queue-family node's delivery path: something is consuming from it or being delivered to it.
 *  Shared by every fan-out family below that asks "is this already going somewhere downstream." */
export const DELIVERY_SEMANTICS: readonly EdgeSemantic[] = ['consumes', 'deliversTo', 'fansOut'];

export interface FanOutTarget {
  /** Stable id: named in tests, dismissals, and the reasons table — same contract as
   *  `ContinuationRule.id`. */
  id: string;
  tier: ContinuationTier;
  label: string;
  reason: string;
  node: Omit<FragmentNodeSpec, 'key'>;
  /** Whether this target stays offered on an explicit ask once an equivalent relationship already
   *  exists (a second Queue off a Topic is still the point). Default `true`, matching every
   *  existing fan-out rule; set `false` for a target that should only ever appear once. */
  repeatableOnDrop?: boolean;
}

export interface FanOutOptions {
  /** See `ContinuationRule.surfaces`. */
  surfaces?: 'invoke';
  /** See `ContinuationRule.branches`. */
  branches?: boolean;
}

/**
 * The single most common continuation shape in this codebase: an anchor category with real
 * evidence it needs *something* next gets one rule per possible target. Every target still goes
 * through the engine's own capability-matrix gate, so a target that isn't actually a legal
 * connection for a given source category in `sourceCategories` is silently never offered for it —
 * this is what lets one call list several targets across several source categories without
 * hand-sorting which apply to which (see `rules.ts`'s Object Storage family for a concrete case:
 * a Queue target and a Topic target are both listed once, and the matrix alone decides that an
 * Object Storage anchor gets both while a Topic anchor would only ever get the Queue one).
 *
 * `evidence` is the "has this actually started, not just theoretically could" check — `nb.in`/
 * `nb.out` shapes vary by family (a Scheduler needs no inbound; a Topic does), so it is supplied
 * by the caller rather than fixed here.
 */
export interface ChainRecipe extends FanOutOptions {
  id: string;
  tier: ContinuationTier;
  /** What the pill says — for a chain, its shape: "Queue → Worker". */
  label: string;
  reason: string;
  sources: readonly NodeCategory[];
  /** Same contract as `defineFanOut`'s `evidence`: only consulted on the quiet trigger. */
  evidence: (nb: Neighborhood) => boolean;
  /** The nodes the recipe adds, in order: anchor → first → second → … */
  chain: readonly Omit<FragmentNodeSpec, 'key'>[];
}

/**
 * A small topology rather than a single node — "another subscriber" is `Queue → Worker`, not just
 * a Queue. Declarative on purpose: a recipe names its nodes and nothing else; every connector
 * along the chain is inferred and matrix-checked like any other, placement follows the chain
 * outward from the anchor, and accepting adds the whole chain as one step.
 */
export function defineChain(recipe: ChainRecipe): ContinuationRule {
  const { chain, sources, evidence, surfaces, branches } = recipe;
  return {
    id: recipe.id,
    tier: recipe.tier,
    label: recipe.label,
    reason: recipe.reason,
    when: (nb, trigger) => sources.includes(nb.category) && (isExplicit(trigger) || evidence(nb)),
    fragment: () => ({
      nodes: chain.map((node, i) => ({ key: `n${i}`, ...node })),
      edges: chain.map((_, i) => ({ from: i === 0 ? 'anchor' : `n${i - 1}`, to: `n${i}` })),
    }),
    repeatable: isExplicit,
    surfaces,
    branches,
  };
}

export function defineFanOut(
  sourceCategories: readonly NodeCategory[],
  evidence: (nb: Neighborhood) => boolean,
  targets: readonly FanOutTarget[],
  options: FanOutOptions = {},
): ContinuationRule[] {
  const when = (nb: Neighborhood, trigger: ContinuationTrigger) =>
    sourceCategories.includes(nb.category) && (isExplicit(trigger) || evidence(nb));
  return targets.map((target) => ({
    id: target.id,
    tier: target.tier,
    label: target.label,
    reason: target.reason,
    when,
    fragment: () => ({
      nodes: [{ key: 'target', ...target.node }],
      edges: [{ from: 'anchor', to: 'target' }],
    }),
    repeatable: (trigger: ContinuationTrigger) => (target.repeatableOnDrop ?? true) && isExplicit(trigger),
    ...options,
  }));
}
