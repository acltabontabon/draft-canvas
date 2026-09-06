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

import type {
  Accent,
  ActorKind,
  BoundaryPreset,
  ComponentKind,
  DatabaseKind,
  DraftNodeType,
  EdgeAnchor,
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
] as const;

export type StarterId = (typeof STARTER_IDS)[number];

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
  /** Omitted means the type/kind's own default label. Queues never take one — see `defaultTextFor`. */
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
  from: string;
  to: string;
  sourceAnchor?: EdgeAnchor;
  targetAnchor?: EdgeAnchor;
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
}

export interface ArchitectureStarter {
  id: StarterId;
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
}
