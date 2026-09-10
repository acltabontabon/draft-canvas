import { SEMANTIC_DEFAULTS } from './edgeSemantics';
import type { ConnectorKind, DraftEdge, DraftNode, EdgeSemantic } from './types';

/**
 * A node's role for connection-semantics purposes — coarser than
 * `DraftNodeType` (which silhouette to draw) and finer than "ignore the node
 * type entirely." `external`, `worker`, `scheduler`, `gateway`, `cache`, `topic`, `fileSystem`,
 * `objectStorage`, and `searchIndex` come from a node's *sub-kind*
 * (`serviceKind`/`databaseKind`/`queueKind`), not a distinct `DraftNodeType`,
 * because that's what they already are in the document model — see
 * `nodes/describe.ts`. `queueKind: 'stream'` stays folded into `queue`, and
 * `databaseKind: 'sql'`/`'nosql'` both stay folded into `database`, and
 * `serviceKind: 'api'` stays folded into `service` — each gets its own
 * *shape*, but no relationship rule below distinguishes it from its plain
 * sibling. Every `DraftNodeType` not covered here (card, note, code, text,
 * group, ellipse, rounded) reads as `generic`: Draft Canvas has no real basis
 * to infer anything about a plain shape, so it stays out of this entirely.
 *
 * `component` is a deliberate exception to that "no basis to infer" rule: unlike a plain shape, a
 * Component genuinely does call things, get called, and read/write storage — it just isn't a
 * `service` (no deployment/runtime connotation). It gets its own category (never silently folded
 * into `generic`, so a future capability that queries category can still tell a Component from a
 * Note), but `resolved()` below folds it to `service` for matrix *lookups* the same way
 * `external`/`worker`/`scheduler`/`gateway` already are — the relationship vocabulary (calls,
 * writes, reads, …) between a Service and a Database is exactly the vocabulary between a Component
 * and a Database; only the deployment implication differs, and that lives entirely in
 * `categoryOf`'s own return value and in `nodes/describe.ts`'s rendering, never in the matrix. The
 * one place that folding would be wrong — a Component talking to *another* Component or Adapter,
 * where "calls" wrongly implies a network hop — gets its own exact `component>component` row
 * instead (see the `MATRIX` below), which `capabilityFor` checks before `resolved()` ever runs.
 * `componentKind` generic/module/adapter never sub-divide the category further — none of those
 * three carries its own relationship rule. `port` is the one Component kind that does: a port is
 * a *contract*, not a thing that does work, and it takes part in exactly two relationships — it
 * is called or used by whatever depends on it, and implemented by whatever satisfies it — so it
 * gets its own `port` category with its own rows below, and never folds to `service` or
 * `component` (a port doesn't write to a database or publish to a queue; something that
 * implements it does).
 */
export type NodeCategory =
  | 'actor'
  | 'service'
  | 'external'
  | 'worker'
  | 'scheduler'
  | 'gateway'
  | 'component'
  | 'port'
  | 'database'
  | 'cache'
  | 'fileSystem'
  | 'objectStorage'
  | 'searchIndex'
  | 'queue'
  | 'topic'
  | 'junction'
  | 'deadLetter'
  | 'generic';

type CategorizableNode = Pick<DraftNode, 'type'> &
  Partial<Pick<DraftNode, 'serviceKind' | 'databaseKind' | 'queueKind' | 'deliveryRole' | 'componentKind'>>;

export function categoryOf(node: CategorizableNode): NodeCategory {
  switch (node.type) {
    case 'actor':
      return 'actor';
    case 'service':
      switch (node.serviceKind) {
        case 'external':
          return 'external';
        case 'worker':
          return 'worker';
        case 'scheduler':
          return 'scheduler';
        case 'gateway':
          return 'gateway';
        default:
          return 'service';
      }
    case 'database':
      switch (node.databaseKind) {
        case 'cache':
          return 'cache';
        case 'file-system':
          return 'fileSystem';
        case 'object-storage':
          return 'objectStorage';
        case 'search-index':
          return 'searchIndex';
        default:
          return 'database';
      }
    case 'queue':
      // A dead-letter queue is still a queue-shaped thing (`resolved()` folds it back to `queue`
      // for every pairing without its own row), but the pairing that *feeds* it — a queue
      // parking a message it gave up on — is its own relationship, so it needs its own category
      // for the matrix to see it at all. Checked ahead of `queueKind`: a DLQ is always a plain
      // queue underneath (`addDeadLetterQueue` never generates one for a Topic or a Stream).
      if (node.deliveryRole === 'dead-letter') return 'deadLetter';
      return node.queueKind === 'topic' ? 'topic' : 'queue';
    case 'ellipse':
      return 'junction';
    case 'component':
      return node.componentKind === 'port' ? 'port' : 'component';
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
  /**
   * Whether a freshly inferred connector for this pairing is asynchronous (`DraftEdge.async`) —
   * a dashed line — as well as carrying `defaultBehavior`. Most pairings leave this unset: an
   * `event` behaviour already dots its own line, and a call is synchronous unless the user says
   * otherwise. Only a pairing whose behaviour has no dash of its own but whose meaning is
   * genuinely asynchronous (a queue dead-lettering a message after its delivery attempts run
   * out) needs it.
   */
  defaultAsync?: boolean;
  status?: RelationshipStatus;
  guidance?: string;
  quickFix?: RelationshipQuickFix;
}

function capability(
  relations: EdgeSemantic[],
  defaultRelation: EdgeSemantic | undefined,
  behaviors: ConnectorKind[],
  defaultBehavior?: ConnectorKind,
  opinion?: Pick<ConnectionCapability, 'status' | 'guidance' | 'quickFix' | 'defaultAsync'>,
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
 * actor↔database, database↔topic, fileSystem↔queue, objectStorage↔database,
 * searchIndex>service, anything touching a `generic` node, …) has no
 * contextual opinion at all — `capabilityFor` returns `undefined` and callers
 * fall back to full, unrestricted behaviour, exactly as today. Only pairs the
 * product spec actually describes get a rule; extending this to a new node
 * type or pairing means adding one line here, not touching any rendering
 * code. `cache`/`topic`/`fileSystem`/`objectStorage`/`searchIndex` never fall
 * back to `database`/`queue` for an unlisted pairing — same "no opinion beats
 * a wrong one" rule `external` doesn't follow (see `resolved` below), applied
 * consistently to every other sub-kind-derived category.
 */
const MATRIX: Record<string, ConnectionCapability> = {
  // Also covers SQL and NoSQL — both fold into the plain `database` category
  // (see `categoryOf`): each gets its own *shape*, but the same read/write/
  // query vocabulary as Generic, deliberately, rather than implementation-
  // specific verbs like "executes"/"scans" for a distinction the product
  // spec itself calls optional.
  'service>database': capability(['writes', 'reads', 'query', 'dependsOn'], 'writes', []),
  'database>service': capability(['reads', 'query', 'dependsOn'], 'reads', []),
  // Cache gets one verb a plain database connection structurally can't
  // express — invalidating a cached copy is a different architectural move
  // than writing through to a system of record.
  'service>cache': capability(['writes', 'reads', 'invalidates', 'dependsOn'], 'writes', []),
  'cache>service': capability(['reads', 'dependsOn'], 'reads', []),
  // Read-oriented only, same restraint `database>service`/`cache>service`
  // already apply — a file system doesn't initiate an ordinary service call.
  'service>fileSystem': capability(['reads', 'writes', 'watches', 'dependsOn'], 'writes', []),
  'fileSystem>service': capability(['reads', 'dependsOn'], 'reads', []),
  'service>objectStorage': capability(['reads', 'writes', 'dependsOn'], 'writes', []),
  'objectStorage>service': capability(['reads', 'dependsOn'], 'reads', []),
  // 'reads' deliberately omitted — 'searches' already covers querying, and a
  // third near-synonym would just be vocabulary bloat.
  'service>searchIndex': capability(['searches', 'indexes', 'dependsOn'], 'searches', []),
  // Object storage is the one storage kind that legitimately triggers a
  // downstream event (e.g. an "object created" notification) — this reuses
  // the *existing* publish vocabulary (already `service>queue`/`service>
  // topic`'s own default) rather than inventing a new "notifies" term.
  // Deliberately not extended to database/cache/fileSystem — this is Object
  // Storage's own documented exception, not "storage can publish events."
  'objectStorage>queue': capability(['publishes', 'event', 'dependsOn'], 'publishes', [], 'event'),
  'objectStorage>topic': capability(['publishes', 'event', 'dependsOn'], 'publishes', [], 'event'),
  'service>queue': capability(['publishes', 'command', 'event', 'dependsOn'], 'publishes', [], 'event'),
  'queue>service': capability(['consumes', 'deliversTo', 'event', 'dependsOn'], 'consumes', [], 'event'),
  'service>service': capability(
    ['calls', 'http', 'grpc', 'command', 'query', 'event', 'dependsOn'],
    'calls',
    CALL_BEHAVIORS,
  ),
  // The one exact-match row `component` needs of its own, rather than folding through `resolved()`
  // to `service>service`'s 'calls' default: two Components (or a Component and an Adapter — a
  // `componentKind` never changes `categoryOf`'s category, so this one row covers both) talking to
  // each other is a plain in-process dependency, not a network call, and the word "calls" is
  // actively misleading there. `capabilityFor` checks this exact key *before* falling back to
  // resolved categories, so this takes priority over the `service>service` entry above without
  // touching it. An Adapter's OTHER edges — toward a Database/Queue/external Service — have no
  // exact `component>…` row and so still fall through to `resolved()`'s service-shaped behaviour
  // (writes/reads/publishes/calls), which is exactly right: "internal-like toward the application,
  // service-like toward infrastructure" falls out of `categoryOf` alone, no new sub-category needed.
  'component>component': capability(['uses', 'dependsOn', 'calls'], 'uses', []),
  // A port is a contract owned by whatever sits behind it (an application core's inbound/outbound
  // ports, a plugin boundary, a module's published interface). Every arrow keeps its runtime
  // direction — a caller calls the port, the port is implemented by what sits behind it — and the
  // words are what carry dependency inversion: `implementedBy` says the thing *after* the port
  // depends on the port's owner, not the other way round. `port` never folds (see `resolved()`),
  // so any pairing not listed here has no opinion: a port doesn't write, publish, or route.
  'service>port': capability(['calls', 'dependsOn'], 'calls', []),
  'component>port': capability(['uses', 'dependsOn'], 'uses', []),
  'port>component': capability(['implementedBy', 'dependsOn'], 'implementedBy', []),
  'port>service': capability(['implementedBy', 'dependsOn'], 'implementedBy', []),
  // The one mistake worth a nudge: wiring a port straight to storage makes the port look like an
  // infrastructure-owned thing. It's a contract; an adapter implements it and talks to the store.
  'port>database': capability(['dependsOn'], undefined, [], undefined, {
    status: 'unusual',
    guidance: 'A port is a contract — something implements it and talks to the data store.',
  }),
  // `command` and `query` because a person's request is one or the other more often than it's
  // neither — the two halves of CQRS, read straight off the client's own connectors.
  'actor>service': capability(['calls', 'http', 'command', 'query'], 'calls', []),
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
  // A queue parking a message it has given up delivering — the same edge `addDeadLetterQueue`
  // generates, now also what a hand-drawn Queue → DLQ connector infers, so the two can't drift.
  // `failure` has no dash pattern of its own (`edges/kindStyle.ts`), and dead-lettering is
  // genuinely asynchronous, so this is the one row that also asks for a dashed line.
  'queue>deadLetter': capability(['deadLetters', 'dependsOn'], 'deadLetters', [], 'failure', {
    defaultAsync: true,
  }),
  // A Topic never dead-letters: it fans a message out and is done. Retries, and where a poison
  // message ends up after they run out, belong to each consumer's own delivery path — the same
  // rule `addDeadLetterQueue` enforces by refusing a Topic, restated here as guidance for a
  // connector someone draws by hand rather than a dead end.
  'topic>deadLetter': capability(['dependsOn'], undefined, [], undefined, {
    status: 'unusual',
    guidance: "A topic doesn't dead-letter — retries and a DLQ belong to each consumer's own queue.",
  }),
  // Deliberately not JDBC/synchronous-request-shaped — see `defaultsToResponse`, which this
  // pairing is intentionally absent from. "Ingests" is the default because it's the most
  // common intent when a fresh connection is drawn; the others are equally valid, explicit
  // choices, not lesser alternatives.
  'database>database': capability(['ingests', 'replicates', 'cdc', 'syncs', 'dependsOn'], 'ingests', []),
  // The one place a Worker's own architectural role (background processor, not a request
  // handler) changes a default rather than just a shape: an indexer worker builds the index
  // rather than querying it. Same relation options as the plain `service>searchIndex` entry —
  // 'indexes' just outranks 'searches' as the likely intent for this specific pairing.
  'worker>searchIndex': capability(['searches', 'indexes', 'dependsOn'], 'indexes', []),
  // Scheduler's whole reason for existing: it initiates on a recurring interval, not on being
  // called, so its default reads 'triggers' rather than the plain-service 'calls' it would
  // otherwise collapse to. Needs its own key for both `service` and `worker` targets — `worker`
  // also resolves away to `service`, so it isn't reached by `scheduler>service` alone (see
  // `capabilityFor`'s both-sides-resolve fallback).
  'scheduler>service': capability(['triggers', 'calls', 'dependsOn'], 'triggers', []),
  'scheduler>worker': capability(['triggers', 'calls', 'dependsOn'], 'triggers', []),
  // Scheduler->Queue/Topic (a schedule initiating work by publishing a message) needs no entry
  // here at all: `queue`/`topic` are unaffected by `resolved()`, so `capabilityFor` already falls
  // through Scheduler's own service-fallback straight to `service>queue`/`service>topic`'s
  // existing 'publishes' default — exactly the right behaviour, for free.
  // Gateway's whole reason for existing: it directs traffic onward rather than being the
  // ultimate handler, so its default reads 'routes' rather than plain-service 'calls'.
  'gateway>service': capability(['routes', 'calls', 'dependsOn'], 'routes', []),
  // Chained gateways (an edge gateway routing to a BFF) keep the same 'routes' default instead
  // of collapsing to plain `calls`.
  'gateway>gateway': capability(['routes', 'calls', 'dependsOn'], 'routes', []),
  // A gateway routing straight to storage is architecturally unusual — most gateways route to
  // services, not data stores — so these get a guidance nudge rather than a prominent default,
  // and deliberately no `quickFix`: there's no clean one-click graph transform for "don't do
  // this," unlike `queue>topic`'s Insert Worker. One entry per storage category since none of
  // cache/fileSystem/objectStorage/searchIndex falls back to `database` (see the matrix's own
  // "no opinion beats a wrong one" rule above) — a single `gateway>database` entry wouldn't
  // reach any of them, and without an explicit row each would otherwise fall through to the
  // *prominent* `service>cache`/etc. default instead of being flagged.
  'gateway>database': capability(['dependsOn', 'writes', 'reads', 'query'], undefined, [], undefined, {
    status: 'unusual',
    guidance: 'A Gateway routing directly to a data store is unusual — most gateways route to services, not storage.',
  }),
  'gateway>cache': capability(['dependsOn', 'writes', 'reads', 'invalidates'], undefined, [], undefined, {
    status: 'unusual',
    guidance: 'A Gateway routing directly to a data store is unusual — most gateways route to services, not storage.',
  }),
  'gateway>fileSystem': capability(['dependsOn', 'reads', 'writes', 'watches'], undefined, [], undefined, {
    status: 'unusual',
    guidance: 'A Gateway routing directly to a data store is unusual — most gateways route to services, not storage.',
  }),
  'gateway>objectStorage': capability(['dependsOn', 'reads', 'writes'], undefined, [], undefined, {
    status: 'unusual',
    guidance: 'A Gateway routing directly to a data store is unusual — most gateways route to services, not storage.',
  }),
  'gateway>searchIndex': capability(['dependsOn', 'searches', 'indexes'], undefined, [], undefined, {
    status: 'unusual',
    guidance: 'A Gateway routing directly to a data store is unusual — most gateways route to services, not storage.',
  }),
};

/** `port` never folds — a contract is not a flavour of anything, and an unlisted pairing that touched
 *  it should stay neutral rather than inherit `service`'s or `component`'s verbs. `deadLetter` is a flavour of `queue` (a DLQ is consumed, re-driven and published into exactly like
 *  any other queue — only the pairing that feeds it has its own row above), and `external`,
 *  `worker`, `scheduler`, `gateway`, and `component` are all flavours of `service` for
 *  every pairing that doesn't have its own explicit entry above — same "no opinion beats a wrong
 *  one" rule every other sub-kind-derived category follows (see the matrix's own doc comment), just
 *  with a fallback instead of nothing, because all five remain fundamentally service-shaped (they
 *  call things, get called, read/write storage) for anything the matrix doesn't say otherwise
 *  about. Unlike `cache`/`fileSystem`/`objectStorage`/`searchIndex`, none of these five has a
 *  failure mode where inheriting plain Service semantics would be actively misleading — worst case,
 *  an unlisted pairing just reads as an ordinary call. `component` folding here is still what lets
 *  every Component/Adapter pairing with actual infrastructure (a database, a queue, an external
 *  service) inherit that vocabulary for free; the one place folding to `service` would be actively
 *  wrong — two Components talking to each other — has its own exact `component>component` row
 *  above instead, checked first by `capabilityFor` before this fallback is ever reached. */
function resolved(category: NodeCategory): NodeCategory {
  if (category === 'deadLetter') return 'queue';
  return category === 'external' ||
    category === 'worker' ||
    category === 'scheduler' ||
    category === 'gateway' ||
    category === 'component'
    ? 'service'
    : category;
}

/**
 * The contextual capability for a source/target category pair, or `undefined`
 * when Draft Canvas has no opinion — see the matrix's own doc comment.
 */
export function capabilityFor(source: NodeCategory, target: NodeCategory): ConnectionCapability | undefined {
  const exact = MATRIX[`${source}>${target}`];
  if (exact) return exact;
  const resolvedSource = resolved(source);
  const resolvedTarget = resolved(target);
  if (resolvedSource !== source || resolvedTarget !== target) {
    return MATRIX[`${resolvedSource}>${resolvedTarget}`];
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
 * marker for exactly this: the pairings whose `defaultRelation` resolves to
 * `'calls'` — `service>service` itself (ambiguous enough to offer `'sync'`
 * as a real behaviour choice), every pairing that resolves to it via
 * `external`/`worker` folding back to `service` (so `service>external`,
 * anything touching a Worker, and so on), and `actor>service`, synchronous
 * by predetermination with no behaviour picker at all — are the only ones
 * this is true for. A pairing predetermined to something else entirely —
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
 * replies. Scheduler is excluded for the same reason, even though it folds
 * to `service` via `resolved()` like Worker/External/Gateway do — firing on
 * a schedule is fire-and-forget, not a call that waits for a reply. Gateway
 * is deliberately *not* excluded: a reverse proxy genuinely does forward a
 * request and return the response, so `defaultsToResponse('gateway',
 * 'service')` staying `true` is correct, not an oversight. Component↔Component
 * is excluded for the same reason as Scheduler, checked before the `resolved()`
 * fold rather than after: its exact `component>component` matrix row defaults
 * to 'uses', not a call, so a reply line has nothing to be a reply *to*.
 */
export function defaultsToResponse(source: NodeCategory, target: NodeCategory): boolean {
  if (source === 'scheduler') return false;
  if (source === 'component' && target === 'component') return false;
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

type Relationship = { kind?: ConnectorKind; semantic?: EdgeSemantic; async?: boolean };

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
  return { semantic: found.defaultRelation, kind: found.defaultBehavior, async: found.defaultAsync };
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
