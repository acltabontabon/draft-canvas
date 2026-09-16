import { capabilityFor, categoryOf } from '../document/connectorSemantics';
import type { DraftDocument, DraftNode, ViewLevel } from '../document/types';
import { ANCHOR_TYPES, neighborhoodOf } from './context';
import { ANY_CANDIDATE, dismissalKey } from './dismissal';
import { existingTargetCandidates } from './existing';
import { rank } from './rank';
import { RULES } from './rules';
import type {
  Continuation,
  ContinuationRule,
  ContinuationTrigger,
  DismissalKey,
  Fragment,
  FragmentNodeSpec,
  Neighborhood,
} from './types';

export interface ContinuationOptions {
  /** Escaped offers. The quiet trigger honours them; explicit callers usually pass none. */
  dismissed?: ReadonlySet<DismissalKey>;
  /** Rule ids accepted recently in this session — a light ranking hint only (`rank.ts`). */
  recent?: readonly string[];
  rules?: readonly ContinuationRule[];
  /** What the view is showing, where that is known — see `src/depth/level.ts`. */
  level?: ViewLevel;
}

/**
 * Whether a rule belongs at the altitude the view is drawn at.
 *
 * Two ways a rule can care, and the difference between them is the policy: `silentAt` quietens a
 * rule at an altitude where it would be noise (a dead-letter queue has no business in a diagram of
 * systems and the people who use them) but leaves it alone everywhere else, *including* where
 * nothing is known; `levels` restricts a rule to an altitude it only makes sense at, and requires
 * the level to have actually been set. So a level the user chose can take a suggestion away, and
 * only a level the user chose can introduce one — nothing ever changes on a guess.
 */
function fitsLevel(rule: ContinuationRule, level: ViewLevel | undefined): boolean {
  const known = level !== undefined && level !== 'none' ? level : undefined;
  if (rule.levels && (known === undefined || !rule.levels.includes(known))) return false;
  if (rule.silentAt && known !== undefined && rule.silentAt.includes(known)) return false;
  return true;
}

/**
 * The continuations Draft Canvas is willing to offer for one node, best first — or none. Two
 * sources: the authored `RULES` (new nodes, alone or as a short chain) and `existing.ts` (a
 * connector to a suitable node already drawn nearby — never in the drop picker, whose whole point
 * is a new node where the user let go).
 *
 * Deterministic by construction: the same document, anchor, trigger and options always produce
 * the same array. The pipeline is generate → technical validity → suppression → confidence →
 * rank, and every stage is generic; a rule contributes only its `when` and its fragment.
 *
 * - **Validity** is the capability matrix, never the rule. Every fragment edge must resolve to a
 *   pairing with a default relation and no `unusual`/`questionable` status. If the matrix changes,
 *   the rules follow; a rule physically cannot surface a pairing the matrix rejects.
 * - **Suppression** is where the feature knows when to stay quiet: an equivalent relationship
 *   already leaving the anchor (unless the rule is `repeatable` for this trigger), and a
 *   dismissal pinned to this exact neighborhood.
 * - **Confidence** is derived, not authored: `high` only for a `primary` rule whose quiet-trigger
 *   evidence holds and which repeats nothing already drawn. The quiet `'select'` trigger returns
 *   only `high` candidates; the explicit triggers return everything, ordered.
 * - **Order** is `rank.ts`: confidence, then contextual signals, then tier and declaration order.
 */
export function continuationsFor(
  doc: DraftDocument,
  anchorId: string,
  trigger: ContinuationTrigger,
  options: ContinuationOptions = {},
): Continuation[] {
  const { dismissed = EMPTY, recent = NONE, rules = RULES, level } = options;
  const nb = neighborhoodOf(doc, anchorId, level);
  if (!nb || !ANCHOR_TYPES.has(nb.node.type)) return [];
  if (dismissed.has(dismissalKey(anchorId, ANY_CANDIDATE, nb.key))) return [];

  const candidates: Continuation[] = [];
  for (const rule of rules) {
    if (rule.surfaces === 'invoke' && trigger !== 'invoke') continue;
    if (!fitsLevel(rule, nb.level)) continue;
    if (dismissed.has(dismissalKey(anchorId, rule.id, nb.key))) continue;
    if (!rule.when(nb, trigger)) continue;
    const evaluated = evaluate(doc, nb, rule);
    if (!evaluated || !offeredFor(rule, evaluated, trigger)) continue;
    candidates.push(evaluated.candidate);
  }
  if (trigger !== 'drop') {
    for (const candidate of existingTargetCandidates(doc, nb)) {
      if (dismissed.has(dismissalKey(anchorId, candidate.id, nb.key))) continue;
      if (trigger === 'select' && candidate.confidence !== 'high') continue;
      candidates.push(candidate);
    }
  }
  return rank(candidates, { nb, recent });
}

export interface ContinuationSets {
  /** What `'select'` would return — honouring `dismissed`. */
  quiet: Continuation[];
  /** What `'invoke'` would return — dismissals deliberately ignored: asking always answers. */
  explicit: Continuation[];
}

/**
 * `continuationsFor(…, 'select', options)` and `continuationsFor(…, 'invoke', { recent })` in one
 * pass — the selected node's quiet suggestion and everything `]` can step through — for a caller
 * that needs both on every document change. One neighborhood, one walk over the rules, one
 * connect-to-existing scan; each rule's fragment is built and matrix-checked once.
 */
export function continuationSets(
  doc: DraftDocument,
  anchorId: string,
  options: Omit<ContinuationOptions, 'rules'> = {},
): ContinuationSets {
  const { dismissed = EMPTY, recent = NONE, level } = options;
  const nb = neighborhoodOf(doc, anchorId, level);
  if (!nb || !ANCHOR_TYPES.has(nb.node.type)) return { quiet: [], explicit: [] };
  const quietAllowed = !dismissed.has(dismissalKey(anchorId, ANY_CANDIDATE, nb.key));

  const quiet: Continuation[] = [];
  const explicit: Continuation[] = [];
  for (const rule of RULES) {
    if (!fitsLevel(rule, nb.level)) continue;
    const asked = rule.when(nb, 'invoke');
    const quietly =
      quietAllowed && rule.surfaces !== 'invoke' && !dismissed.has(dismissalKey(anchorId, rule.id, nb.key)) && rule.when(nb, 'select');
    if (!asked && !quietly) continue;
    const evaluated = evaluate(doc, nb, rule);
    if (!evaluated) continue;
    if (asked && offeredFor(rule, evaluated, 'invoke')) explicit.push(evaluated.candidate);
    if (quietly && offeredFor(rule, evaluated, 'select')) quiet.push(evaluated.candidate);
  }
  for (const candidate of existingTargetCandidates(doc, nb)) {
    explicit.push(candidate);
    if (quietAllowed && candidate.confidence === 'high' && !dismissed.has(dismissalKey(anchorId, candidate.id, nb.key))) {
      quiet.push(candidate);
    }
  }
  return { quiet: rank(quiet, { nb, recent }), explicit: rank(explicit, { nb, recent }) };
}

interface Evaluated {
  candidate: Continuation;
  equivalent: boolean;
}

/** A rule's candidate for this neighborhood, trigger-independent — or `undefined` when the matrix
 *  rejects its fragment. The caller has already checked `when`. */
function evaluate(doc: DraftDocument, nb: Neighborhood, rule: ContinuationRule): Evaluated | undefined {
  const fragment = rule.fragment(nb);
  if (!fragmentIsValid(doc, nb, fragment)) return undefined;
  const equivalent = hasEquivalent(doc, nb, fragment);
  const confidence = rule.tier === 'primary' && !equivalent && rule.when(nb, 'select') ? 'high' : 'medium';
  return {
    equivalent,
    candidate: {
      id: rule.id,
      ruleId: rule.id,
      tier: rule.tier,
      confidence,
      score: 0,
      label: rule.label,
      actionLabel: `Add ${rule.label}`,
      fragment,
      branches: rule.branches,
      anchorId: nb.node.id,
      neighborhoodKey: nb.key,
    },
  };
}

/** Suppression and the quiet trigger's confidence floor, for one evaluated rule. */
function offeredFor(rule: ContinuationRule, { candidate, equivalent }: Evaluated, trigger: ContinuationTrigger): boolean {
  if (equivalent && !(rule.repeatable?.(trigger) ?? false)) return false;
  return trigger !== 'select' || candidate.confidence === 'high';
}

const EMPTY: ReadonlySet<DismissalKey> = new Set();
const NONE: readonly string[] = [];

/** What a fragment edge end refers to: the anchor, a node the fragment adds, or a node already drawn. */
function resolveRef(
  doc: DraftDocument,
  nb: Neighborhood,
  fragment: Fragment,
  ref: string,
): FragmentNodeSpec | DraftNode | undefined {
  if (ref === 'anchor') return nb.node;
  const spec = fragment.nodes.find((n) => n.key === ref);
  if (spec) return spec;
  const existing = fragment.existing?.find((e) => e.key === ref);
  return existing ? doc.nodes.find((n) => n.id === existing.nodeId) : undefined;
}

/** Every edge the fragment would add must be one the matrix offers with a clean status. */
function fragmentIsValid(doc: DraftDocument, nb: Neighborhood, fragment: Fragment): boolean {
  if (fragment.edges.length === 0) return false;
  if (fragment.nodes.length === 0 && (fragment.existing?.length ?? 0) === 0) return false;
  return fragment.edges.every((spec) => {
    const from = resolveRef(doc, nb, fragment, spec.from);
    const to = resolveRef(doc, nb, fragment, spec.to);
    if (!from || !to) return false;
    const capability = capabilityFor(categoryOf(from), categoryOf(to));
    return capability?.defaultRelation !== undefined && (capability.status ?? 'valid') === 'valid';
  });
}

/**
 * "The user already drew this": an outgoing connector from the anchor whose semantic is what the
 * fragment's connector from the anchor would infer. Compared on semantic, not on target category,
 * so a hand-drawn `Queue → Service` (consumes) counts as the consumer a `Queue → Worker` rule
 * would add.
 */
function hasEquivalent(doc: DraftDocument, nb: Neighborhood, fragment: Fragment): boolean {
  return fragment.edges.some((spec) => {
    if (spec.from !== 'anchor') return false;
    const to = resolveRef(doc, nb, fragment, spec.to);
    if (!to) return false;
    const semantic = capabilityFor(nb.category, categoryOf(to))?.defaultRelation;
    return semantic !== undefined && nb.out.some(({ edge }) => edge.semantic === semantic);
  });
}
