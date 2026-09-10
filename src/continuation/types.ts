import type { NodeCategory } from '../document/connectorSemantics';
import type {
  Accent,
  ActorKind,
  ComponentKind,
  DatabaseKind,
  DeliveryRole,
  DraftEdge,
  DraftNode,
  DraftNodeType,
  QueueKind,
  ServiceKind,
} from '../document/types';

/**
 * When a continuation is being asked for. `'select'` is the quiet case — a single node is
 * selected and nothing else is happening — so only the strongest rules speak. `'drop'` is the
 * explicit case — the user dragged a connector from the node into empty canvas — so every
 * defensible rule is offered, ordered.
 */
export type ContinuationTrigger = 'select' | 'drop';

/**
 * How strongly a rule can justify itself. `primary` is "the thing you were about to draw" and may
 * appear unprompted; `secondary` is "a defensible companion" and only appears once the user has
 * shown intent to continue (a drop). There is deliberately no third tier: anything weaker than
 * `secondary` is not a rule.
 */
export type ContinuationTier = 'primary' | 'secondary';

export interface IncidentEdge {
  edge: DraftEdge;
  /** The node at the other end. */
  other: DraftNode;
  category: NodeCategory;
}

/** Everything a rule may look at: one node and its one-hop surroundings. Nothing further. */
export interface Neighborhood {
  node: DraftNode;
  category: NodeCategory;
  out: IncidentEdge[];
  in: IncidentEdge[];
  /** Stable fingerprint of the neighborhood — what a dismissal is pinned to. */
  key: string;
}

export interface FragmentNodeSpec {
  /** Fragment-local name an edge spec refers to. */
  key: string;
  type: DraftNodeType;
  serviceKind?: ServiceKind;
  databaseKind?: DatabaseKind;
  queueKind?: QueueKind;
  actorKind?: ActorKind;
  componentKind?: ComponentKind;
  deliveryRole?: DeliveryRole;
  text?: string;
  accent?: Accent;
}

export interface FragmentEdgeSpec {
  /** `'anchor'` is the node the continuation hangs off; anything else is a `FragmentNodeSpec.key`. */
  from: 'anchor' | string;
  to: 'anchor' | string;
  deliveryAttempts?: number;
}

/**
 * What accepting a continuation adds, described without positions or ids. Semantics are never
 * stated here — every edge reads the capability matrix when materialized, exactly like a
 * hand-drawn connector — so a fragment cannot claim a relationship the matrix would not infer.
 */
export interface Fragment {
  nodes: FragmentNodeSpec[];
  edges: FragmentEdgeSpec[];
}

export interface ContinuationRule {
  /** Stable id: named in tests, dismissals, and the reasons table in `docs/SEMANTICS.md`. */
  id: string;
  tier: ContinuationTier;
  /** What the offer is called: "Queue", "Worker", "Dead-letter queue". */
  label: string;
  /** One authored sentence saying why — never generated. Surfaced in Learn mode and tests. */
  reason: string;
  when(nb: Neighborhood, trigger: ContinuationTrigger): boolean;
  fragment(nb: Neighborhood): Fragment;
  /**
   * Whether an equivalent outgoing relationship already existing should *not* suppress the rule
   * for this trigger. A fan-out rule says yes on `'drop'` — a second Queue off a Topic is the
   * point. Default: never repeatable.
   */
  repeatable?(trigger: ContinuationTrigger): boolean;
}

/** The engine's output — presentation-agnostic. */
export interface Continuation {
  ruleId: string;
  tier: ContinuationTier;
  label: string;
  reason: string;
  fragment: Fragment;
  anchorId: string;
  neighborhoodKey: string;
}

/** A continuation with real, positioned elements — what a preview shows and an accept commits. */
export interface MaterializedContinuation extends Continuation {
  nodes: DraftNode[];
  edges: DraftEdge[];
  /** The node the offer is *about* (first in the fragment): selected after accept, animated in. */
  primaryNodeId: string;
}

/** `${anchorId}|${ruleId}|${neighborhoodKey}` — see `dismissalKey`. */
export type DismissalKey = string;
