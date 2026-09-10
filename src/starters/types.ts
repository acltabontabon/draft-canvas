/**
 * Architecture Starters — the definition model.
 *
 * A starter is a *authored* opening composition for a canonical architecture: a small, deliberately
 * arranged set of ordinary Draft Canvas elements. Nothing here becomes a special kind of node. Once
 * inserted, a starter is indistinguishable from a diagram someone drew by hand — every node, edge
 * and boundary is a normal `DraftNode`/`DraftEdge`, fully editable, undoable, and serializable.
 *
 * This module deliberately imports nothing but `document/`, and no React. A starter is not part of
 * the `.draftcanvas` format (which is why this does not live in `src/document/`), but it produces
 * nothing that isn't already in it.
 */

import type { CreateAttachmentInput } from '../document/factory';
import type {
  Accent,
  ActorKind,
  BoundaryPreset,
  ComponentKind,
  DatabaseKind,
  DeliveryRole,
  DraftNodeType,
  EdgeAnchor,
  EdgeRouting,
  EdgeSemantic,
  QueueKind,
  RouteMode,
  ServiceKind,
} from '../document/types';

export const STARTER_IDS = [
  'monolith',
  'modular-monolith',
  'microservices',
  'event-driven',
  'hexagonal',
  'bff',
  'cqrs',
  'saga-orchestration',
  'transactional-outbox',
] as const;

export type StarterId = (typeof STARTER_IDS)[number];

/**
 * Where a starter sits in discovery. *Starter* is the umbrella: one architectural idea at one
 * scope. An `architecture` answers "how are the major parts of this system organized?"; a
 * `pattern` answers "how do I solve this particular recurring design problem?" — a saga, an
 * outbox. The line is pragmatic, not academic (BFF and CQRS are strictly patterns, but they shape
 * a system's structure enough to belong with the architectures), it exists only so the palette
 * can show two short lists instead of one long one, and it never implies exclusivity: a real
 * system composes several — Event-Driven with CQRS and an Outbox, Microservices with a BFF and a
 * Saga. A pattern starter is drawn at the scope of the problem it solves, never padded to look
 * like an architecture.
 */
export type StarterCategory = 'architecture' | 'pattern';

/** The two categories in display order, with the header each discovery surface shows for it —
 *  the palette, the empty canvas and the Library welcome all read this one list. */
export const STARTER_CATEGORIES: readonly { id: StarterCategory; label: string }[] = [
  { id: 'architecture', label: 'Architectures' },
  { id: 'pattern', label: 'Patterns' },
];

/**
 * One element of a starter, in the starter's own coordinate space — the top-left corner of the
 * whole composition is wherever `buildStarter` is told to put it, and every spec is relative to
 * that. Authoring in local coordinates is what lets a starter be inserted anywhere (an empty
 * canvas, or beside an existing diagram) without its composition changing at all.
 *
 * `key` is local to one starter and is resolved to a real generated id at build time, so two
 * insertions of the same starter never collide.
 */
export interface StarterNodeSpec {
  key: string;
  type: DraftNodeType;
  x: number;
  y: number;
  /** Omitted means the type's own default from `factory.ts`'s `defaultSizeFor`. */
  width?: number;
  height?: number;
  /**
   * Omitted means the type/kind's own default label. A queue's default is no name at all (see
   * `defaultTextFor` — its kind caption is its label, and a name is optional, never prefilled);
   * a starter names only the queue-family node a composition genuinely revolves around
   * (Event-Driven's `Domain Events` topic), never a plain delivery queue, and sizes it with the
   * named-queue box (`DEFAULTS.queueNamedHeight`) so the name and caption fit inside it.
   */
  text?: string;
  accent?: Accent;
  serviceKind?: ServiceKind;
  databaseKind?: DatabaseKind;
  queueKind?: QueueKind;
  actorKind?: ActorKind;
  componentKind?: ComponentKind;
  boundaryPreset?: BoundaryPreset;
  /** `text` nodes only — see `DraftNode.annotation`. */
  annotation?: boolean;
  /** `queue` nodes only — see `DraftNode.deliveryRole`. A dead-letter queue is drawn as one
   *  (dashed tube, `DLQ` caption) and categorised as one by the capability matrix. */
  deliveryRole?: DeliveryRole;
  /** Supporting detail folded into the node as click-to-reveal chips (`DraftNode.attachments`) —
   *  the same depth-without-a-visible-node mechanism `StarterEdgeSpec.attachments` gives a
   *  connector. `id`s are minted at build time. */
  attachments?: CreateAttachmentInput[];
  /** Another spec's `key`. Resolved to `parentId`; coordinates stay absolute, as everywhere else. */
  parent?: string;
}

/**
 * One connection in a starter.
 *
 * Deliberately carries no `semantic` and no `kind`: both are derived at build time from
 * `document/connectorSemantics.ts`'s capability matrix, exactly the way `connect()`,
 * `insertWorkerOnEdge` and `addConsumer` already derive theirs. A starter therefore cannot state a
 * relationship the rest of the app would disagree with, and cannot go stale when the matrix
 * changes — `tests/starters.test.ts` asserts the equality directly.
 *
 * Anchors, by contrast, *are* authored: composition is the whole point of a starter, and a
 * deterministic side/offset is what keeps a fan-out symmetric instead of letting `chooseSides`
 * re-derive it from whatever the nodes' relative positions happen to be.
 */
export interface StarterEdgeSpec {
  /**
   * A starter-local name for this connector, resolved to its generated edge id at build time —
   * the same idea as `StarterNodeSpec.key`, and only needed on a connector a `StarterFlowSpec`
   * step refers to. It is also the only thing that tells two connectors between the same pair of
   * nodes apart (a saga orchestrator's "reserve" and its later "refund" to the same service), so
   * `from`/`to` deliberately isn't the identity.
   */
  key?: string;
  from: string;
  to: string;
  sourceAnchor?: EdgeAnchor;
  targetAnchor?: EdgeAnchor;
  /**
   * A relation other than the pairing's default, chosen from the ones the capability matrix
   * already *offers* for it — exactly what a user gets by picking it in the inspector, and stamped
   * `semanticsOrigin: 'explicit'` the same way. This is not an escape from "relationships come
   * from the matrix": `build.ts` ignores a value the matrix doesn't list for the pair, so a starter
   * still cannot state a relationship the rest of the app would disagree with. It exists for the
   * pairing whose default is the wrong fact for one composition — a query API reaching a read
   * store is `reads`, never `service>database`'s default `writes`; a client submitting to a
   * command API is a `command`, not a plain `calls`. Behaviour (`kind`) and dashing stay the
   * pairing's own defaults.
   */
  semantic?: EdgeSemantic;
  /**
   * An explicit caption, overriding whatever the capability matrix would otherwise show — the
   * *port* a connector crosses (e.g. "Inbound Port"), which is a position in the architecture, not
   * a relationship `connectorSemantics.ts` has any opinion about. Sparingly: this is the one
   * escape hatch from "relationships come from the matrix," and it changes what's displayed only —
   * the edge's own `semantic`/`kind` are still derived and persisted exactly as normal, so the
   * connector remains exactly as re-inference-eligible and exportable as any other. Absent means
   * what it always has: let the inferred relationship's own default label show.
   */
  label?: string;
  /**
   * A small, bordered secondary annotation — visually subordinate to whatever caption `label`
   * or the inferred relationship shows (see `styles/canvas.css`'s `.dc-edge-condition`: "a small,
   * secondary tag, never competing with the label for attention"). This is the lighter-weight
   * counterpart to `label` above: use it for something the diagram should mention but not lead
   * with — Hexagonal's "Inbound Port"/"Outbound Port" — leaving the primary caption slot free to
   * show the plain inferred relationship (`calls`, `writes`, …) in its own quietest style.
   */
  condition?: string;
  /**
   * `'direct'` opts this connector out of Smart Routing's fan-out/fan-in bundling
   * (`edges/bundles.ts`), so it always renders as its own independent line rather than sharing a
   * trunk with sibling connectors off the same node/side. A starter reaches for this when several
   * connectors leaving one hub are meant to read as distinct relationships rather than one
   * collapsed-caption fan — Smart Routing's bundling is exactly right for a plain fan-out, but
   * wrong for something like an inbound adapter dispatching into separate, independently-owned
   * capabilities, where one shared trunk/caption would visually flatten them into a single
   * relationship. Absent means the normal, bundle-eligible default every other starter connector
   * already uses.
   */
  routeMode?: RouteMode;
  /**
   * Line style — `'smoothstep'` (the default every other starter connector uses), `'bezier'`, or
   * `'straight'`. A starter reaches for `'straight'` when several `routeMode: 'direct'` connectors
   * leave a shared hub at different anchor points and need to read as deliberate, individually
   * aimed rays rather than each independently computing its own step/bend — a plain point-to-point
   * line has no bend height to land inconsistently.
   */
  routing?: EdgeRouting;
  /**
   * How many delivery attempts precede this connector's failure route — only meaningful on an
   * edge the matrix infers as `deadLetters` (see `DraftEdge.deliveryAttempts`), where it renders
   * as the caption "after N attempts." A number, not a relationship: the relationship itself is
   * still derived.
   */
  deliveryAttempts?: number;
  /**
   * Supporting detail folded into the connector as click-to-reveal chips (`DraftEdge.attachments`)
   * — an event's example payload on the connector that publishes it, an operational note on a
   * dead-letter route. The one place a starter carries *depth* without adding a single visible
   * node: the chip is small, the card opens only on a click, and nothing about the connector's own
   * semantics changes. `id`s are minted at build time.
   */
  attachments?: CreateAttachmentInput[];
}

/** One step of a predefined flow: the connector it walks (by `StarterEdgeSpec.key`) and an
 *  optional caption — exactly what `document/flow.ts`'s `addStepToFlow` accepts. */
export interface StarterFlowStepSpec {
  edgeKey: string;
  caption?: string;
}

/**
 * A flow a starter ships with — an ordered walkthrough of its own connectors, built into an
 * ordinary `DraftFlow` alongside the nodes and edges. This is how a starter carries a *second
 * reading* of the same diagram without a second diagram: CQRS's write path and read path, a
 * saga's happy path and its compensation. Nothing is duplicated; steps only reference connectors
 * by key, so a flow can never disagree with the composition it belongs to. Selecting the flow
 * dims everything outside it (`flow.ts`'s lens tiers) and presenting it walks the steps in order.
 */
export interface StarterFlowSpec {
  title: string;
  accent?: Accent;
  steps: StarterFlowStepSpec[];
}

export interface ArchitectureStarter {
  id: StarterId;
  category: StarterCategory;
  /** The command palette's row title. A pattern name, never "… template". */
  name: string;
  /** One line, shown as the palette row's muted hint. */
  description: string;
  /**
   * Extra phrasings fuzzy search should match — see `commands/fuzzy.ts`'s `scoreEntry`.
   *
   * Every alias must be *specific to this pattern*. An alias beginning with a word that already
   * names a shape ("service oriented", "queue…", "database…") wins the prefix bonus for that whole
   * word and shoves the corresponding Add command down the list — `serv` has to keep meaning
   * "Add Service", not "Microservices". `tests/commands-registry.test.ts` pins that.
   */
  aliases: string[];
  nodes: StarterNodeSpec[];
  edges: StarterEdgeSpec[];
  /** Predefined flows over `edges` — see `StarterFlowSpec`. Absent means none, the common case. */
  flows?: StarterFlowSpec[];
}
