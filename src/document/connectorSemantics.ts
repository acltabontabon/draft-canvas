import { SEMANTIC_DEFAULTS } from './edgeSemantics';
import type { ConnectorKind, DraftEdge, DraftNode, EdgeSemantic } from './types';

/**
 * A node's role for connection-semantics purposes — coarser than
 * `DraftNodeType` (which silhouette to draw) and finer than "ignore the node
 * type entirely." `external`, `cache`, and `topic` come from a node's
 * *sub-kind* (`serviceKind`/`databaseKind`/`queueKind`), not a distinct
 * `DraftNodeType`, because that's what they already are in the document model
 * — see `nodes/describe.ts`. `queueKind: 'stream'` stays folded into `queue`;
 * no relationship rule below distinguishes it from a plain queue. Every
 * `DraftNodeType` not covered here (card, note, code, text, group, ellipse,
 * rounded) reads as `generic`: Draft Canvas has no real basis to infer
 * anything about a plain shape, so it stays out of this entirely.
 */
export type NodeCategory =
  | 'actor'
  | 'service'
  | 'external'
  | 'database'
  | 'cache'
  | 'queue'
  | 'topic'
  | 'junction'
  | 'generic';

type CategorizableNode = Pick<DraftNode, 'type'> &
  Partial<Pick<DraftNode, 'serviceKind' | 'databaseKind' | 'queueKind'>>;

export function categoryOf(node: CategorizableNode): NodeCategory {
  switch (node.type) {
    case 'actor':
      return 'actor';
    case 'service':
      return node.serviceKind === 'external' ? 'external' : 'service';
    case 'database':
      return node.databaseKind === 'cache' ? 'cache' : 'database';
    case 'queue':
      return node.queueKind === 'topic' ? 'topic' : 'queue';
    case 'ellipse':
      return 'junction';
    default:
      return 'generic';
  }
}

/**
 * How architecturally ordinary a category pair is. Omitted (or `'valid'`) is
 * the default for every pairing that doesn't say otherwise — the vast
 * majority. `'unusual'` is drawable with no friction but gets a subtle nudge
 * (see `guidance`/`quickFix` below); `'questionable'` is modeled for a future
 * pairing that would warrant stronger guidance but isn't assigned to any
 * current pair — Draft Canvas never hard-blocks a connection on this alone.
 */
export type RelationshipStatus = 'valid' | 'unusual' | 'questionable';

/**
 * A one-click resolution offered alongside `guidance`. `'insert-worker'`
 * performs a real graph transform (see `store/editorStore.ts`'s
 * `insertWorkerOnEdge`); `'retarget-relation'` just relabels the edge's own
 * `semantic` — used both as a static, matrix-level fix (none currently) and
 * computed per-edge by `quickFixesFor` when an edge's explicit `semantic`
 * no longer fits its (possibly re-pointed) endpoints.
 */
export type RelationshipQuickFix =
  | { id: 'insert-worker'; label: string }
  | { id: 'retarget-relation'; label: string; semantic: EdgeSemantic };

/**
 * What a connection between two node categories is capable of — the single
 * source of truth `EdgeInspectorPopover.tsx` reads to decide what to show,
 * and `inferRelationship` reads to decide what a fresh connection starts as.
 *
 * `relations`/`behaviors` are the contextually relevant options, in display
 * order — never a "you may only pick from these" restriction:
 * `EdgeInspectorPopover.tsx` always keeps an edge's *current* value
 * selectable, so an unusual pre-existing or deliberately-chosen value is
 * never hidden or clobbered. An empty `behaviors` list means the behaviour is
 * predetermined (or trivial enough — a plain synchronous call — not to be
 * worth a picker at all); `defaultBehavior`, if set, is what to display as a
 * compact indicator in that case.
 *
 * `status`/`guidance`/`quickFix` are the "is this pairing itself unusual"
 * layer, orthogonal to which relation label gets picked — `status` defaults
 * to `'valid'` when omitted (every pairing below except `queue>topic` today),
 * `guidance` is only ever shown when `status !== 'valid'`, and `quickFix` is
 * an optional matrix-level fix (see `quickFixesFor` for the edge-aware kind).
 */
export interface ConnectionCapability {
  relations: readonly EdgeSemantic[];
  defaultRelation?: EdgeSemantic;
  behaviors: readonly ConnectorKind[];
  defaultBehavior?: ConnectorKind;
  status?: RelationshipStatus;
  guidance?: string;
  quickFix?: RelationshipQuickFix;
}

function capability(
  relations: EdgeSemantic[],
  defaultRelation: EdgeSemantic | undefined,
  behaviors: ConnectorKind[],
  defaultBehavior?: ConnectorKind,
  opinion?: Pick<ConnectionCapability, 'status' | 'guidance' | 'quickFix'>,
): ConnectionCapability {
  return { relations, defaultRelation, behaviors, defaultBehavior, ...opinion };
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
 * Deliberately sparse: a pair with no entry (queue↔queue, topic↔topic,
 * actor↔database, database↔topic, anything touching a `generic` node, …) has
 * no contextual opinion at all — `capabilityFor` returns `undefined` and
 * callers fall back to full, unrestricted behaviour, exactly as today. Only
 * pairs the product spec actually describes get a rule; extending this to a
 * new node type or pairing means adding one line here, not touching any
 * rendering code. `cache`/`topic` never fall back to `database`/`queue` for
 * an unlisted pairing — same "no opinion beats a wrong one" rule `external`
 * doesn't follow (see `resolved` below), applied consistently to every other
 * sub-kind-derived category.
 */
const MATRIX: Record<string, ConnectionCapability> = {
  'service>database': capability(['writes', 'reads', 'query', 'dependsOn'], 'writes', []),
  'database>service': capability(['reads', 'query', 'dependsOn'], 'reads', []),
  'service>cache': capability(['writes', 'reads', 'dependsOn'], 'writes', []),
  'cache>service': capability(['reads', 'dependsOn'], 'reads', []),
  'service>queue': capability(['publishes', 'command', 'event', 'dependsOn'], 'publishes', [], 'event'),
  'queue>service': capability(['consumes', 'deliversTo', 'event', 'dependsOn'], 'consumes', [], 'event'),
  'service>service': capability(
    ['calls', 'http', 'grpc', 'command', 'query', 'event', 'dependsOn'],
    'calls',
    CALL_BEHAVIORS,
  ),
  'actor>service': capability(['calls', 'http', 'command'], 'calls', []),
  'service>external': capability(
    ['calls', 'http', 'grpc', 'command', 'event', 'dependsOn'],
    'calls',
    CALL_BEHAVIORS,
  ),
  'service>topic': capability(['publishes', 'event', 'dependsOn'], 'publishes', [], 'event'),
  // A topic fans a message out to every subscriber rather than one worker pulling it off a
  // queue — 'deliversTo' (not 'consumes') is the default here for exactly that reason, unlike
  // `queue>service` above which keeps 'consumes'.
  'topic>service': capability(['deliversTo', 'consumes', 'dependsOn'], 'deliversTo', [], 'event'),
  'topic>queue': capability(['fansOut', 'deliversTo', 'dependsOn'], 'fansOut', [], 'event'),
  // Deliberately NOT the inverse of 'topic>queue' — a queue doesn't itself publish into a
  // topic; something normally has to consume it and forward the message. Narrower relation
  // list, no default (nothing should ever auto-infer into this), 'unusual' status with a
  // one-click way to make the implied worker explicit instead of just accepting the arrow.
  'queue>topic': capability(['dependsOn', 'event'], undefined, [], undefined, {
    status: 'unusual',
    guidance: "A queue doesn't typically publish to a topic — something usually consumes it and forwards the message.",
    quickFix: { id: 'insert-worker', label: 'Insert Worker' },
  }),
  // Deliberately not JDBC/synchronous-request-shaped — see `defaultsToResponse`, which this
  // pairing is intentionally absent from. "Ingests" is the default because it's the most
  // common intent when a fresh connection is drawn; the others are equally valid, explicit
  // choices, not lesser alternatives.
  'database>database': capability(['ingests', 'replicates', 'cdc', 'syncs', 'dependsOn'], 'ingests', []),
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
 * The quick fixes worth offering for one specific edge — `capability`'s own
 * static `quickFix` (if any, e.g. `queue>topic`'s Insert Worker) plus a
 * computed one when the *edge's own* `semantic` no longer fits its (possibly
 * re-pointed) endpoints: an explicit choice is never silently reset (see
 * `isEligibleForReinference` — reconnecting only auto-reclassifies an edge
 * nothing has explicitly claimed), but a one-click way to fix it up is still
 * worth surfacing. Returns `[]` when there's nothing to suggest — the normal
 * case for a `'valid'` pairing whose edge already picked (or was inferred)
 * something in `capability.relations`.
 */
export function quickFixesFor(
  cap: ConnectionCapability | undefined,
  edge: Pick<DraftEdge, 'semantic'>,
): RelationshipQuickFix[] {
  if (!cap) return [];
  const fixes: RelationshipQuickFix[] = [];
  if (cap.quickFix) fixes.push(cap.quickFix);
  if (edge.semantic !== undefined && !cap.relations.includes(edge.semantic) && cap.defaultRelation !== undefined) {
    const label = SEMANTIC_DEFAULTS[cap.defaultRelation].label;
    fixes.push({ id: 'retarget-relation', label: `Use "${label}" instead`, semantic: cap.defaultRelation });
  }
  return fixes;
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

/**
 * Which side of an edge a Junction is being resolved as — see
 * `resolveTransparentCategory`. `'source'` looks at what feeds the Junction
 * (its incoming edges); `'target'` looks at what it feeds (its outgoing
 * edges).
 */
export type EdgeEndpointRole = 'source' | 'target';

/** The bits of a `DraftDocument` `resolveTransparentCategory`/`inferredJunctionSemantic` need —
 *  a `DraftDocument` itself, or any other `{ nodes, edges }` shape, satisfies this structurally. */
interface GraphLike {
  nodes: readonly DraftNode[];
  edges: readonly DraftEdge[];
}

/**
 * Resolves what a node "looks like" for connection-capability purposes, seeing straight through
 * any Junction on the way — a Junction organizes topology, it has no semantic identity of its
 * own (see this module's Junction connection spec). A non-Junction node just resolves to its own
 * `categoryOf`. A Junction resolves to whatever real node feeds it on the requested `role`: the
 * categories of the nodes on the other end of its *incoming* edges when asked as a `'source'`
 * (what supplies it), or of its *outgoing* edges' targets when asked as a `'target'` (what it
 * feeds) — recursing through any further Junctions on that same side. A single, unambiguous
 * non-Junction category resolves to that category; none, or more than one distinct category,
 * resolves to `'junction'` itself — the module's own existing "no opinion" signal (`capabilityFor`
 * has no matrix entry for it, so callers already fall back to the full, unrestricted vocabulary),
 * which is exactly the "don't guess" behaviour an unfed or ambiguous convergence needs.
 */
export function resolveTransparentCategory(
  graph: GraphLike,
  nodeId: string,
  role: EdgeEndpointRole,
  visited: Set<string> = new Set(),
): NodeCategory {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) return 'generic';
  const own = categoryOf(node);
  if (own !== 'junction' || visited.has(nodeId)) return own;
  visited.add(nodeId);
  const neighborIds =
    role === 'source'
      ? graph.edges.filter((e) => e.target === nodeId).map((e) => e.source)
      : graph.edges.filter((e) => e.source === nodeId).map((e) => e.target);
  const resolved = new Set<NodeCategory>();
  for (const id of neighborIds) {
    const category = resolveTransparentCategory(graph, id, role, visited);
    if (category !== 'junction') resolved.add(category);
  }
  return resolved.size === 1 ? [...resolved][0]! : 'junction';
}

/**
 * The literal `semantic` a Junction's incoming edges converge on, when there is exactly one to
 * converge on — the "smart inheritance" default for a *new* outgoing edge (Junction connection
 * spec, requirement 3). An edge with no `semantic` at all doesn't vote either way; more than one
 * distinct value present (or none present) means there's no clear default — an ambiguous
 * convergence (requirement 4), left for the caller to fall back to the ordinary capability-based
 * default and the user to pick explicitly, same as anywhere else in this module.
 */
export function inferredJunctionSemantic(graph: GraphLike, junctionNodeId: string): EdgeSemantic | undefined {
  const semantics = new Set<EdgeSemantic>();
  for (const e of graph.edges) {
    if (e.target === junctionNodeId && e.semantic !== undefined) semantics.add(e.semantic);
  }
  return semantics.size === 1 ? [...semantics][0] : undefined;
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
