import { capabilityFor, categoryOf } from '../document/connectorSemantics';
import type { DraftDocument, DraftNodeType } from '../document/types';
import { neighborhoodOf } from './context';
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

/** Node types a continuation can hang off. Annotations, boundaries and routing points never do. */
const ANCHOR_TYPES: ReadonlySet<DraftNodeType> = new Set<DraftNodeType>(['service', 'database', 'queue', 'actor', 'component']);

export function dismissalKey(anchorId: string, ruleId: string, neighborhoodKey: string): DismissalKey {
  return `${anchorId}|${ruleId}|${neighborhoodKey}`;
}

/**
 * The continuations Draft Canvas is willing to offer for one node, best first — or none.
 *
 * Deterministic by construction: the same document, anchor, trigger and dismissals always
 * produce the same array. The pipeline is generate → technical validity → suppression → order,
 * and every stage is generic; a rule contributes only its `when` and its fragment.
 *
 * - **Validity** is the capability matrix, never the rule. Every fragment edge must resolve to a
 *   pairing with a default relation and no `unusual`/`questionable` status. If the matrix changes,
 *   the rules follow; a rule physically cannot surface a pairing the matrix rejects.
 * - **Suppression** is where the feature knows when to stay quiet: an equivalent relationship
 *   already leaving the anchor (unless the rule is `repeatable` for this trigger), a dismissal
 *   pinned to this exact neighborhood, and — on the quiet `'select'` trigger — anything below
 *   `primary`.
 * - **Order** is `(tier, position in RULES)`. No scores.
 */
export function continuationsFor(
  doc: DraftDocument,
  anchorId: string,
  trigger: ContinuationTrigger,
  dismissed: ReadonlySet<DismissalKey> = EMPTY,
  rules: readonly ContinuationRule[] = RULES,
): Continuation[] {
  const nb = neighborhoodOf(doc, anchorId);
  if (!nb || !ANCHOR_TYPES.has(nb.node.type)) return [];

  const offered: Continuation[] = [];
  for (const rule of rules) {
    if (trigger === 'select' && rule.tier !== 'primary') continue;
    if (dismissed.has(dismissalKey(anchorId, rule.id, nb.key))) continue;
    if (!rule.when(nb, trigger)) continue;
    const fragment = rule.fragment(nb);
    if (!fragmentIsValid(nb, fragment)) continue;
    if (!(rule.repeatable?.(trigger) ?? false) && hasEquivalent(nb, fragment)) continue;
    offered.push({
      ruleId: rule.id,
      tier: rule.tier,
      label: rule.label,
      reason: rule.reason,
      fragment,
      anchorId,
      neighborhoodKey: nb.key,
    });
  }
  // Stable: primaries first, otherwise the order the rules were declared in.
  return offered.sort((a, b) => tierRank(a) - tierRank(b));
}

const EMPTY: ReadonlySet<DismissalKey> = new Set();

const tierRank = (c: Continuation) => (c.tier === 'primary' ? 0 : 1);

function specOf(nb: Neighborhood, fragment: Fragment, ref: string): FragmentNodeSpec | Neighborhood['node'] | undefined {
  return ref === 'anchor' ? nb.node : fragment.nodes.find((n) => n.key === ref);
}

/** Every edge the fragment would add must be one the matrix offers with a clean status. */
function fragmentIsValid(nb: Neighborhood, fragment: Fragment): boolean {
  if (fragment.nodes.length === 0 || fragment.edges.length === 0) return false;
  return fragment.edges.every((spec) => {
    const from = specOf(nb, fragment, spec.from);
    const to = specOf(nb, fragment, spec.to);
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
function hasEquivalent(nb: Neighborhood, fragment: Fragment): boolean {
  return fragment.edges.some((spec) => {
    if (spec.from !== 'anchor') return false;
    const to = specOf(nb, fragment, spec.to);
    if (!to) return false;
    const semantic = capabilityFor(nb.category, categoryOf(to))?.defaultRelation;
    return semantic !== undefined && nb.out.some(({ edge }) => edge.semantic === semantic);
  });
}
