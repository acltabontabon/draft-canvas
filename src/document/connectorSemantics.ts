import type { ConnectorKind, DraftEdge, DraftNode, EdgeSemantic } from './types';

/**
 * A node's role for connection-semantics purposes — coarser than
 * `DraftNodeType` (which silhouette to draw) and finer than "ignore the node
 * type entirely." `external` and `cache` come from a node's *sub-kind*
 * (`serviceKind`/`databaseKind`), not a distinct `DraftNodeType`, because
 * that's what they already are in the document model — see `nodes/describe.ts`.
 * Every `DraftNodeType` not covered here (card, note, code, text, group,
 * ellipse, rounded) reads as `generic`: Draft Canvas has no real basis to
 * infer anything about a plain shape, so it stays out of this entirely.
 */
export type NodeCategory =
  | 'actor'
  | 'service'
  | 'external'
  | 'database'
  | 'cache'
  | 'queue'
  | 'junction'
  | 'generic';

type CategorizableNode = Pick<DraftNode, 'type'> & Partial<Pick<DraftNode, 'serviceKind' | 'databaseKind'>>;

export function categoryOf(node: CategorizableNode): NodeCategory {
  switch (node.type) {
    case 'actor':
      return 'actor';
    case 'service':
      return node.serviceKind === 'external' ? 'external' : 'service';
    case 'database':
      return node.databaseKind === 'cache' ? 'cache' : 'database';
    case 'queue':
      return 'queue';
    case 'ellipse':
      return 'junction';
    default:
      return 'generic';
  }
}

/**
 * What a connection between two node categories is capable of — the single
 * source of truth `Inspector.tsx` reads to decide what to show, and
 * `inferRelationship` reads to decide what a fresh connection starts as.
 *
 * `relations`/`behaviors` are the contextually relevant options, in display
 * order — never a "you may only pick from these" restriction: `Inspector.tsx`
 * always keeps an edge's *current* value selectable and offers a "Show all…"
 * escape hatch, so an unusual pre-existing or deliberately-chosen value is
 * never hidden or clobbered. An empty `behaviors` list means the behaviour is
 * predetermined (or trivial enough — a plain synchronous call — not to be
 * worth a picker at all); `defaultBehavior`, if set, is what to display as a
 * compact indicator in that case.
 */
export interface ConnectionCapability {
  relations: readonly EdgeSemantic[];
  defaultRelation?: EdgeSemantic;
  behaviors: readonly ConnectorKind[];
  defaultBehavior?: ConnectorKind;
}

function capability(
  relations: EdgeSemantic[],
  defaultRelation: EdgeSemantic | undefined,
  behaviors: ConnectorKind[],
  defaultBehavior?: ConnectorKind,
): ConnectionCapability {
  return { relations, defaultRelation, behaviors, defaultBehavior };
}

/**
 * A service-to-service (or service-to-external) call is the one relationship
 * genuinely ambiguous enough to warrant the full behaviour picker: it could
 * be a synchronous HTTP call, a fire-and-forget notification, a retried
 * operation, and so on — Draft Canvas has no basis to guess which.
 * Deliberately excludes `'event'`: that's a queue relationship's behaviour,
 * not a synchronous call's.
 */
const CALL_BEHAVIORS: ConnectorKind[] = ['sync', 'async', 'callback', 'conditional', 'retry', 'failure', 'fallback'];

/**
 * The capability matrix, keyed by `"${source}>${target}"` on the *resolved*
 * category pair (see `capabilityFor` — `external` falls back to `service`'s
 * entry everywhere except its own explicit one below, so this table doesn't
 * need an entry for every category combination `external` participates in).
 *
 * Deliberately sparse: a pair with no entry (queue↔queue, database↔database,
 * actor↔database, anything touching a `generic` node, …) has no contextual
 * opinion at all — `capabilityFor` returns `undefined` and callers fall back
 * to full, unrestricted behaviour, exactly as today. Only pairs the product
 * spec actually describes get a rule; extending this to a new node type or
 * pairing means adding one line here, not touching any rendering code.
 */
const MATRIX: Record<string, ConnectionCapability> = {
  'service>database': capability(['writes', 'reads', 'query', 'dependsOn'], 'writes', []),
  'database>service': capability(['reads', 'query', 'dependsOn'], 'reads', []),
  'service>cache': capability(['writes', 'reads', 'dependsOn'], 'writes', []),
  'cache>service': capability(['reads', 'dependsOn'], 'reads', []),
  'service>queue': capability(['publishes', 'event', 'dependsOn'], 'publishes', [], 'event'),
  'queue>service': capability(['consumes', 'event', 'dependsOn'], 'consumes', [], 'event'),
  'service>service': capability(['calls', 'http', 'command', 'query', 'event', 'dependsOn'], 'calls', CALL_BEHAVIORS),
  'actor>service': capability(['calls', 'http', 'command'], 'calls', []),
  'service>external': capability(['calls', 'http', 'command', 'event', 'dependsOn'], 'calls', CALL_BEHAVIORS),
};

/** `external` is a flavour of `service` for every pairing that doesn't have
 *  its own explicit entry above. */
function resolved(category: NodeCategory): NodeCategory {
  return category === 'external' ? 'service' : category;
}

/**
 * The contextual capability for a source/target category pair, or `undefined`
 * when Draft Canvas has no opinion — see the matrix's own doc comment.
 */
export function capabilityFor(source: NodeCategory, target: NodeCategory): ConnectionCapability | undefined {
  const exact = MATRIX[`${source}>${target}`];
  if (exact) return exact;
  if (source === 'external' || target === 'external') {
    return MATRIX[`${resolved(source)}>${resolved(target)}`];
  }
  return undefined;
}

/**
 * Whether a connector between this category pair reads as a single
 * synchronous call — the only shape a request/response pair
 * (`DraftEdge.response`) makes sense on. `'calls'` is the matrix's own
 * marker for exactly this: the three pairings whose `defaultRelation` is
 * `'calls'` (`service>service`/`service>external`, ambiguous enough to offer
 * `'sync'` as a real behaviour choice, and `actor>service`, synchronous by
 * predetermination with no behaviour picker at all) are the only ones this
 * is true for. A pairing predetermined to something else entirely —
 * `service>database`'s `'writes'`, `service>queue`'s `'publishes'`/`'event'`,
 * etc. — reads `false`, even though some of those also have an empty
 * `behaviors` array; emptiness alone doesn't mean "a call," only
 * `defaultRelation` does. Independent of the edge's *current* `kind`;
 * callers combine this with `edge.kind === undefined || edge.kind ===
 * 'sync'` themselves — mirrors how `AdvancedPanel`'s own
 * `behaviorMatchesPolicy` is a separate concern from `capabilityFor`'s
 * opinion.
 */
export function isSyncPairing(source: NodeCategory, target: NodeCategory): boolean {
  return capabilityFor(source, target)?.defaultRelation === 'calls';
}

/**
 * Whether a fresh connection between these categories should default its
 * reply line on. Narrower than `isSyncPairing` (which also covers
 * `actor>service` — a user may still *manually* add a response there via the
 * inspector's `canHaveResponse` gate). Only two service-shaped boxes talking
 * to each other reads as a request/response conversation by default; a
 * person initiating a call is not itself a service that structurally
 * replies.
 */
export function defaultsToResponse(source: NodeCategory, target: NodeCategory): boolean {
  return resolved(source) === 'service' && resolved(target) === 'service';
}

type Relationship = { kind?: ConnectorKind; semantic?: EdgeSemantic };

/**
 * Infers a connector's relationship semantics from what it actually connects
 * — applied uniformly on a fresh `connect()` and, for an eligible connector
 * (see `isEligibleForReinference`), again whenever it's reconnected, so the
 * same node pairing always reads the same way regardless of how the
 * connector got there. A thin wrapper over `capabilityFor`'s default —
 * everything about *which* pairings infer *what* lives in the matrix above,
 * not here.
 */
export function inferRelationship(source: CategorizableNode, target: CategorizableNode): Relationship | undefined {
  const found = capabilityFor(categoryOf(source), categoryOf(target));
  if (!found?.defaultRelation) return undefined;
  return { semantic: found.defaultRelation, kind: found.defaultBehavior };
}

/**
 * Whether a connector's `semantic`/`kind` may still be recomputed automatically.
 * `true` for a connector inference has already claimed (`semanticsOrigin ===
 * 'inferred'`) or one that has never had either field touched at all. `false`
 * the moment a user has made an explicit choice — including a connector saved
 * before this field existed that already carries a manually-picked `semantic`
 * or `kind`: no `semanticsOrigin` plus a real value there reads as legacy
 * explicit intent, not as "up for grabs."
 */
export function isEligibleForReinference(edge: DraftEdge): boolean {
  if (edge.semanticsOrigin === 'inferred') return true;
  if (edge.semanticsOrigin === 'explicit') return false;
  return edge.semantic === undefined && edge.kind === undefined;
}
