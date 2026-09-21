import { capabilityFor } from '../document/connectorSemantics';
import { displayNameFor } from '../document/factory';
import type { EdgeSemantic } from '../document/types';
import type { Continuation, Neighborhood } from './types';

/** How one service asks another to do a step: the forward half of a saga. */
const FORWARD_STEP: readonly EdgeSemantic[] = ['command', 'calls', 'http', 'grpc'];

/** Never more than this many compensation candidates for one anchor — in the order the steps were drawn. */
const MAX_CANDIDATES = 3;

/**
 * "Undo that step too" — a `compensates` connector from a saga's coordinator to a step it already
 * drives forward but can't yet unwind.
 *
 * The one pattern continuation recognises by name, because the diagram already names it: a
 * `compensates` connector is never inferred (no pairing defaults to it), so one only exists
 * because someone chose it. That choice is the evidence — nothing here reads labels, starters or
 * layout. Everything else must hold too:
 *
 * - the anchor already compensates at least one step (it *is* coordinating a saga, not just
 *   calling things);
 * - the step is one it drives forward (`FORWARD_STEP`) and does not compensate yet;
 * - the matrix offers `compensates` for that pairing (`service>service`, `service>external`);
 * - and **at least two** steps are still uncompensated. A saga's last forward step — its pivot —
 *   legitimately has no compensation: once it commits, the saga only goes forward. With one step
 *   left there is no telling whether it is the pivot or a gap, so a finished saga (the Saga
 *   starter's three steps, two compensations) says nothing. With two or more, at least one of them
 *   is a gap; which one is still the user's call, so each is offered and none is pushed.
 *
 * Always `medium`: reachable by asking (`]`), never ghosted unprompted — wiring an undo into the
 * user's own steps is not a guess to make on selection. Never in the drop picker either, whose
 * point is a new node where the connector was let go.
 */
export function compensationCandidates(nb: Neighborhood): Continuation[] {
  if (!nb.out.some(({ edge }) => edge.semantic === 'compensates')) return [];
  const compensated = new Set(nb.out.filter(({ edge }) => edge.semantic === 'compensates').map(({ other }) => other.id));

  const open = new Map<string, Neighborhood['out'][number]>();
  for (const out of nb.out) {
    if (out.edge.semantic === undefined || !FORWARD_STEP.includes(out.edge.semantic)) continue;
    if (compensated.has(out.other.id) || open.has(out.other.id)) continue;
    if (!capabilityFor(nb.category, out.category)?.relations.includes('compensates')) continue;
    open.set(out.other.id, out);
  }
  if (open.size < 2) return [];

  return [...open.values()].slice(0, MAX_CANDIDATES).map(({ other }) => {
    const name = displayNameFor(other);
    return {
      id: `compensate:${other.id}`,
      ruleId: 'compensate-step',
      tier: 'secondary',
      confidence: 'medium',
      score: 0,
      label: `Compensate ${name}`,
      actionLabel: `Compensate ${name}`,
      fragment: {
        nodes: [],
        edges: [{ from: 'anchor', to: 'target', semantic: 'compensates' }],
        existing: [{ key: 'target', nodeId: other.id }],
      },
      anchorId: nb.node.id,
      neighborhoodKey: nb.key,
    } satisfies Continuation;
  });
}
