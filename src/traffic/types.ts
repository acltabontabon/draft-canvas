/**
 * Traffic analysis: where the traffic a diagram already describes concentrates, and why.
 *
 * Read-only and derived. Nothing here is saved, undone, shared or exported: the analysis is a way of
 * looking at the current room, recomputed from its nodes and connectors, the way a flow's lens is.
 *
 * The one unit is a **modeled path**: each entry point (an Actor, a Scheduler, or a service or queue
 * nothing drawn feeds) starts one path, and every runtime interaction it reaches carries it on. A
 * node reached by three paths is not receiving three requests per second — it is where three drawn
 * routes meet. Paths are never converted into rates, latencies, utilisation or capacity; the diagram
 * holds none of those, and nothing here pretends otherwise.
 *
 * Paths come in two strengths. `definite` paths follow interactions the diagram states plainly. A
 * `possible` path also crosses something whose share is unknown — a Junction that splits, a
 * conditional branch, a queue shared by competing consumers — so it may or may not arrive. Every
 * definite path is also possible (`possible >= definite`); the gap between them is the uncertainty,
 * kept rather than resolved with an invented split.
 *
 * Imports `document/` only: no React, store, canvas or DOM.
 */

import type { DraftEdge, DraftNode } from '../document/types';

/**
 * What a node is to traffic. `compute` processes requests or messages (Service, API, Gateway,
 * Worker, Scheduler, External); `messaging` carries messages (Queue, Topic, Stream, dead-letter
 * queue); `data` stores and serves data (SQL, NoSQL, Cache, Object Storage, File System, Search
 * Index); `origin` starts traffic and is never a resource (any Actor); `junction` is a transparent
 * routing point that is never a resource either. Everything else — Components, Ports, Adapters,
 * logical tables, plain shapes, notes, text, code, boundaries — is `excluded`.
 */
export type TrafficRole = 'compute' | 'messaging' | 'data' | 'origin' | 'junction' | 'excluded';

/** The groups resources are ranked within. Paths are never compared across groups: a request, a
 *  message and a database operation are different kinds of work. */
export type TrafficGroup = 'services' | 'messaging' | 'data';

/** What reaches a resource: synchronous or asynchronous invocations, messages, or data operations. */
export type WorkloadKind = 'request' | 'message' | 'data';

/**
 * What one drawn connector (or one logical route through Junctions) means for traffic.
 *
 * `request`: one runtime node invoking another (calls, HTTP, gRPC, command or query to a service,
 * routes, triggers). `data`: an operation on a data store (reads, writes, reads / writes, query,
 * searches, indexes, invalidates, watches, a topic's ingests/indexes sink). `publish`: a producer
 * handing a message to a queue, topic or stream. `deliver`: messaging handing a message on (consumes,
 * delivers to, fans out). These four carry baseline paths.
 *
 * Never part of baseline paths: `background` (replicates, CDC, syncs, transforms, store-to-store
 * ingests), `failure` (dead-letters, compensates, `failure`/`fallback` behaviour), `retry` (`retry`
 * behaviour — counted only as possible amplification), `callback` (a reply to the caller, not new
 * traffic), `structural` (depends on, uses, implements, implemented by), `participant` (asks,
 * delegates, escalates, notifies — between people and agents), `association` (an undirected line),
 * and `unknown` (nothing establishes what it carries, its segments disagree, or it runs through
 * something that isn't a runtime resource).
 */
export type TrafficClass =
  | 'request'
  | 'data'
  | 'publish'
  | 'deliver'
  | 'background'
  | 'failure'
  | 'retry'
  | 'callback'
  | 'structural'
  | 'participant'
  | 'association'
  | 'unknown';

/** Path counts — see this module's doc comment. Both saturate at `PATH_CAP`. */
export interface PathCount {
  definite: number;
  possible: number;
}

/** Path counts stop growing here (diamond-heavy graphs double per level) and read as "999+". */
export const PATH_CAP = 999;

/**
 * Why a connector's paths are only possible. `junction-split`: a Junction sends it to more than one
 * place and nothing says how it divides. `conditional`: a `conditional` behaviour or a condition
 * chip. `competing-consumers`: one of several consumers of a work queue. `routed`: one of several
 * services a gateway routes to — a gateway sends each request to one of them, not to all. `inferred-trigger`:
 * an event a store publishes on some of its writes.
 */
export type UncertaintyReason = 'junction-split' | 'conditional' | 'competing-consumers' | 'routed' | 'inferred-trigger';

/**
 * One logical runtime interaction between two concrete nodes, after Junctions are seen through and
 * parallel duplicates merged. `from` → `to` is the direction work travels (the caller to the called,
 * the producer to the queue, the queue to its consumer, the doer to the store it operates on) —
 * which is not always the direction the arrow is drawn: Database → Service "read by" is the service
 * reading the database, so `from` is the service and `to` the database.
 */
export interface TrafficInteraction {
  /** Stable: `${from}>${to}>${class}`. */
  id: string;
  from: string;
  to: string;
  class: TrafficClass;
  workload?: WorkloadKind;
  /** The drawn connectors this interaction was read from, in document order. */
  edgeIds: string[];
  /** Junctions crossed, in document order. Empty for a direct connector. */
  junctionIds: string[];
  /** Whether arrivals are definite or only possible, and why. */
  certainty: 'definite' | 'possible';
  uncertainty?: UncertaintyReason;
  /** The caller waits on it: a call or a data operation drawn as a solid line with no async
   *  behaviour. What a synchronous chain — and an element's blast radius — is made of. */
  sync: boolean;
  /** The semantic was absent and read from the connector's own default for its two endpoints. */
  inferred: boolean;
  /** Inside a loop: counted once, with the number of repeats unknown. */
  loop: boolean;
  /** Paths this interaction carries. Zero for every non-baseline class. */
  paths: PathCount;
}

export interface TrafficNode {
  id: string;
  role: TrafficRole;
  group?: TrafficGroup;
  /** Paths reaching this node. An entry point's own path counts: a root API Gateway has 1. */
  paths: PathCount;
  /** Distinct concrete nodes with a baseline interaction into this one, sorted by id. */
  sources: string[];
  /** Distinct concrete nodes this one has a baseline interaction toward, sorted by id. */
  targets: string[];
  /** Entry points whose paths reach this node, sorted by id; at most `MAX_LISTED` of them. */
  entries: string[];
  /** How many entry points reach it in all (`entries` may be cut short). */
  entryCount: number;
  workloads: WorkloadKind[];
  isEntry: boolean;
  /** Part of a loop — see `TrafficInteraction.loop`. */
  inLoop: boolean;
  /**
   * `top`: a place paths meet — two or more distinct sources — with the most paths of its group.
   * `raised`: also a meeting place, below the top. A node with one source is never tiered, however
   * many paths it carries: those paths met further upstream, and that is where the tier goes. `none`: no concentration. Never
   * set for an origin, a Junction or an excluded node, and never a statement about load or capacity.
   */
  tier: 'top' | 'raised' | 'none';
  /** 1 for the most-concentrated node of its group; absent when `tier` is `none`. */
  rank?: number;
}

/**
 * Deterministic observations, each about named elements and each worded to say only what the
 * diagram establishes. `basis: 'modeled'` counts paths; `structural` reads topology alone.
 */
export type TrafficInsightKind =
  | 'convergence'
  | 'shared-dependency'
  | 'external-on-sync'
  | 'dead-end'
  | 'gateway-bypass'
  | 'hub'
  | 'amplification'
  | 'fan-out'
  | 'sync-chain'
  | 'async-buffer'
  | 'message-distribution'
  | 'competing-consumers'
  | 'routed-split'
  | 'retry-amplification'
  | 'ambiguous-split'
  | 'conditional'
  | 'loop'
  | 'scheduler'
  | 'external'
  | 'unsupported-hop'
  | 'undirected'
  | 'conflicting-semantics'
  | 'dangling-junction'
  | 'not-counted'
  | 'no-concentration';

export interface TrafficInsight {
  /** Stable across identical inputs: `${kind}:${sorted subject ids}`. */
  id: string;
  kind: TrafficInsightKind;
  /** Highest first: concentration, then structure, then what the diagram leaves unsaid. */
  severity: 'notable' | 'info' | 'unknown';
  basis: 'modeled' | 'structural';
  /** The element(s) the insight is about, first one primary. */
  nodeIds: string[];
  edgeIds: string[];
  /** One sentence, plain text, names in the diagram's own words. */
  text: string;
  /** A few words to write on the canvas beside `focus`, whiteboard-style — the finding at a glance. */
  note?: string;
  /** The shapes the note circles: what the finding is *about*, which isn't always `nodeIds[0]`. */
  focus?: string[];
}

export type TrafficStatus =
  /** Nothing runtime here: no compute, messaging or data node takes part in a runtime interaction. */
  | 'nothing-to-analyze'
  /** Runtime nodes exist but no entry point starts a path (every one sits in a loop, say). */
  | 'no-entry'
  | 'ok';

export interface TrafficAnalysis {
  status: TrafficStatus;
  /** Every node of the input with a role other than `excluded`, plus excluded nodes that sit on a
   *  connector between runtime nodes (so the canvas can say why a path stopped there). */
  nodes: Map<string, TrafficNode>;
  /** Logical interactions, ordered by `from`, `to`, `class`. */
  interactions: TrafficInteraction[];
  /**
   * Every drawn connector of the input, by id, with what it means here. `flow`: carries baseline
   * paths. `uncertain`: carries only possible paths. `none`: no baseline traffic (structural,
   * failure, background, association, unknown…). A connector shared by several interactions (one
   * leg of a Junction fan-in) takes the strongest of them.
   */
  edges: Map<string, { class: TrafficClass; participation: 'flow' | 'uncertain' | 'none'; paths: PathCount }>;
  /** `tier !== 'none'` nodes, by group then rank, at most `MAX_HOTSPOTS`. */
  hotspots: string[];
  /** Ordered by severity, then kind order above, then id; at most `MAX_INSIGHTS`. */
  insights: TrafficInsight[];
  entries: string[];
  /** Work was cut off by a bound (`TrafficLimits`); results cover what was reached. */
  truncated: boolean;
}

export interface TrafficInput {
  nodes: readonly DraftNode[];
  edges: readonly DraftEdge[];
  /** Analyze only these connectors (a flow's members, say). Absent: every connector. */
  edgeIds?: ReadonlySet<string>;
}

export interface TrafficLimits {
  /** Junction traversal steps across the whole analysis. */
  maxJunctionSteps: number;
  maxInteractions: number;
}

export const DEFAULT_TRAFFIC_LIMITS: TrafficLimits = { maxJunctionSteps: 200_000, maxInteractions: 20_000 };
export const MAX_HOTSPOTS = 8;
export const MAX_INSIGHTS = 12;
export const MAX_LISTED = 50;
