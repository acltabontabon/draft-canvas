import { capabilityFor, categoryOf } from '../document/connectorSemantics';
import type { DraftDocument, DraftNode } from '../document/types';
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
  const nb = neighborhoodOf(doc, anchorId);
  if (!nb || !ANCHOR_TYPES.has(nb.node.type)) return [];
  const { dismissed = EMPTY, recent = NONE, rules = RULES } = options;
  if (dismissed.has(dismissalKey(anchorId, ANY_CANDIDATE, nb.key))) return [];

  const candidates: Continuation[] = [];
  for (const rule of rules) {
    if (rule.surfaces === 'invoke' && trigger !== 'invoke') continue;
    if (dismissed.has(dismissalKey(anchorId, rule.id, nb.key))) continue;
    if (!rule.when(nb, trigger)) continue;
    const fragment = rule.fragment(nb);
    if (!fragmentIsValid(doc, nb, fragment)) continue;
    const equivalent = hasEquivalent(doc, nb, fragment);
    if (equivalent && !(rule.repeatable?.(trigger) ?? false)) continue;
    const confidence = rule.tier === 'primary' && !equivalent && rule.when(nb, 'select') ? 'high' : 'medium';
    if (trigger === 'select' && confidence !== 'high') continue;
    candidates.push({
      id: rule.id,
      ruleId: rule.id,
      tier: rule.tier,
      confidence,
      score: 0,
      label: rule.label,
      actionLabel: `Add ${rule.label}`,
      reason: rule.reason,
      fragment,
      branches: rule.branches,
      anchorId,
      neighborhoodKey: nb.key,
    });
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

const EMPTY: ReadonlySet<DismissalKey> = new Set();
const NONE: readonly string[] = [];

/** What a fragment edge end refers to: the anchor, a node the fragment adds, or a node already drawn. */
export function resolveRef(
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
