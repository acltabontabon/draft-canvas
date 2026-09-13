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
 * selected and nothing else is happening — so only high-confidence candidates speak. The other
 * two are explicit: `'invoke'` is the user asking for alternatives from the keyboard (`]`), and
 * `'drop'` is a connector dragged from the node into empty canvas, which the Quick Connect menu
 * lists. Rules only ever distinguish quiet from explicit — see `isExplicit`.
 */
export type ContinuationTrigger = 'select' | 'invoke' | 'drop';

/**
 * How strongly a rule can justify itself. `primary` is "the thing you were about to draw" and may
 * appear unprompted; `secondary` is "a defensible companion" and only appears once the user has
 * shown intent to continue. There is deliberately no third tier: anything weaker than `secondary`
 * is not a rule.
 */
export type ContinuationTier = 'primary' | 'secondary';

/**
 * How sure the engine is about one candidate *in this neighborhood* — derived, never authored.
 * `high` may ghost unprompted; `medium` is only reachable by asking (cycling, the picker). Low
 * confidence is not a value: such candidates are never generated.
 */
export type ContinuationConfidence = 'high' | 'medium';

export interface IncidentEdge {
  edge: DraftEdge;
  /** The node at the other end. */
  other: DraftNode;
  category: NodeCategory;
}

/**
 * Everything a rule may look at: one node, its one-hop surroundings, and the connectors leaving
 * its outbound neighbors (so a sibling branch like `Topic → Queue → Worker` can be recognised).
 * Nothing further.
 */
export interface Neighborhood {
  node: DraftNode;
  category: NodeCategory;
  out: IncidentEdge[];
  in: IncidentEdge[];
  /** Connectors leaving each outbound neighbor, keyed by that neighbor's id. */
  outOfOut: ReadonlyMap<string, IncidentEdge[]>;
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
  /** `'auto'` keeps a derived name live (it follows kind changes like a factory default). */
  textOrigin?: DraftNode['textOrigin'];
  accent?: Accent;
}

/** A node already on the canvas that a fragment connects to instead of creating. */
export interface FragmentExistingRef {
  key: string;
  nodeId: string;
}

export interface FragmentEdgeSpec {
  /** `'anchor'`, a `FragmentNodeSpec.key`, or a `FragmentExistingRef.key`. */
  from: 'anchor' | string;
  to: 'anchor' | string;
  deliveryAttempts?: number;
}

/**
 * What accepting a continuation adds, described without positions or ids. Semantics are never
 * stated here — every edge reads the capability matrix when materialized, exactly like a
 * hand-drawn connector — so a fragment cannot claim a relationship the matrix would not infer.
 *
 * A fragment is one node (`Queue`), a short chain (`Queue → Worker`), or only a connector to
 * something already drawn (`existing`, no `nodes`).
 */
export interface Fragment {
  nodes: FragmentNodeSpec[];
  edges: FragmentEdgeSpec[];
  existing?: FragmentExistingRef[];
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
   * for this trigger. A fan-out rule says yes when asked explicitly — a second Queue off a Topic
   * is the point. Default: never repeatable.
   */
  repeatable?(trigger: ContinuationTrigger): boolean;
  /**
   * `'invoke'`: only offered when asked from the keyboard, never in the Quick Connect menu (whose
   * standing presets already cover the same shapes) and never unprompted.
   */
  surfaces?: 'invoke';
  /**
   * The anchor fans out, so a second branch shaped like one it already has is the likeliest next
   * move — ranking boosts this rule when that sibling exists (see `rank.ts`).
   */
  branches?: boolean;
}

/** The engine's output — presentation-agnostic. */
export interface Continuation {
  /** Unique per anchor: the rule id, or `connect-existing:<nodeId>`. Cycling and dismissal key on it. */
  id: string;
  /** The rule (or provider) that produced it — shared by every candidate of that kind. */
  ruleId: string;
  tier: ContinuationTier;
  confidence: ContinuationConfidence;
  /** Ranking weight from contextual signals; only meaningful relative to its siblings. */
  score: number;
  /** Short name on the ghost's pill: "Queue", "Queue → Worker", "Connect to Order Events". */
  label: string;
  /** What accepting does, as a command: "Add Queue", "Connect to Order Events". */
  actionLabel: string;
  reason: string;
  fragment: Fragment;
  /** Carried from the rule for ranking — see `ContinuationRule.branches`. */
  branches?: boolean;
  anchorId: string;
  neighborhoodKey: string;
}

/** A continuation with real, positioned elements — what a preview shows and an accept commits. */
export interface MaterializedContinuation extends Continuation {
  /** New nodes only — an existing node a fragment connects to is never copied here. */
  nodes: DraftNode[];
  edges: DraftEdge[];
  /**
   * Where the architectural sentence now ends — the last node of the fragment's chain, or the
   * existing node it connected to. Selected after accept, so continuation chains from there.
   */
  continueFromId: string;
}

/** `${anchorId}|${candidateId}|${neighborhoodKey}` — see `dismissalKey`. */
export type DismissalKey = string;
