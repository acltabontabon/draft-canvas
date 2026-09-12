/**
 * The Draft Canvas document model.
 *
 * This module is deliberately free of React and of any canvas library. It is the
 * stable, serializable representation that `.draftcanvas` files contain and that
 * IndexedDB stores. Rendering libraries are adapted *to* this model, never the
 * other way around, so that upgrading the canvas engine cannot break user files.
 */

export const DRAFT_FORMAT = 'draft-canvas' as const;

/** Bump when the on-disk shape changes, and add a migration in `migrate.ts`. */
export const CURRENT_VERSION = 11;

export type DraftFormat = typeof DRAFT_FORMAT;

/**
 * The node vocabulary is intentionally small. Developer presets (service,
 * database, queue, actor) are distinct types rather than styled cards because
 * they carry recognisable silhouettes, but they share one renderer and one set
 * of behaviours.
 */
export const NODE_TYPES = [
  'ellipse',
  'text',
  'note',
  'code',
  'group',
  'service',
  'database',
  'queue',
  'actor',
  'component',
] as const;

export type DraftNodeType = (typeof NODE_TYPES)[number];

export const NOTE_KINDS = ['note', 'question', 'warning', 'decision'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

/**
 * A Text node's semantic hierarchy — "this is a Heading," not "21px semibold." The renderer
 * (`nodes/describe.ts`) owns what each role actually looks like; the document only ever stores
 * intent. `'label'` is the same quiet, chip-less treatment `annotation` has always meant — see
 * `DraftNode.textRole`'s own doc comment for how the two reconcile.
 */
export const TEXT_ROLES = ['body', 'label', 'heading', 'title', 'technical'] as const;
export type TextRole = (typeof TEXT_ROLES)[number];

export const TEXT_ALIGNS = ['left', 'center', 'right'] as const;
export type TextAlign = (typeof TEXT_ALIGNS)[number];

export const CODE_LANGUAGES = [
  'plaintext',
  'java',
  'javascript',
  'typescript',
  'json',
  'yaml',
  'xml',
  'sql',
  'bash',
  'http',
  'log',
] as const;
export type CodeLanguage = (typeof CODE_LANGUAGES)[number];

/** Restrained, semantic accents. Not a colour picker. */
export const ACCENTS = ['neutral', 'teal', 'blue', 'violet', 'amber', 'rose', 'green'] as const;
export type Accent = (typeof ACCENTS)[number];

export const EDGE_ROUTINGS = ['smoothstep', 'bezier', 'straight'] as const;
export type EdgeRouting = (typeof EDGE_ROUTINGS)[number];

/**
 * How much freedom the router has over a connector's path. Deliberately not a
 * full mode enum: "smart" is the absence of a value, so every edge ever
 * written — including every file saved before this field existed — is already
 * in the automatic mode, and only a user who explicitly took control leaves a
 * trace. See `DraftEdge.routeMode`.
 */
export const ROUTE_MODES = ['direct'] as const;
export type RouteMode = (typeof ROUTE_MODES)[number];

/**
 * The four logical connection edges a node exposes. Lives here, not in
 * `edges/routing.ts`, because it is now part of the serializable schema (see
 * `EdgeAnchor`) — `routing.ts` imports it, not the other way around.
 */
export const SIDES = ['top', 'right', 'bottom', 'left'] as const;
export type Side = (typeof SIDES)[number];

/**
 * Where a connector attaches to a node's boundary: which side, and how far
 * along it. `offset` is a fraction (0..1) of the side's length rather than a
 * pixel value so it survives a resize without drifting off the edge; `0.5` —
 * the side's midpoint — is what every connector used before anchors existed,
 * so it is the default whenever an anchor is absent. Reading direction sets
 * the convention: `0` is the left corner of `top`/`bottom`, and the top
 * corner of `left`/`right`.
 */
export interface EdgeAnchor {
  side: Side;
  offset: number;
}

export const GRID_MODES = ['dots', 'lines', 'none'] as const;
export type GridMode = (typeof GRID_MODES)[number];

/** How a custom canvas background image fills its anchor rectangle — see
 *  `render/backgroundAnchor.ts` and `canvas/CanvasBackground.tsx`. */
export const BACKGROUND_FITS = ['cover', 'contain', 'tile'] as const;
export type BackgroundFit = (typeof BACKGROUND_FITS)[number];

/** Sub-kinds of the developer presets. Purely a labelling convenience — the
 *  base type's silhouette and accent always dominate; see `nodes/describe.ts`. */
export const SERVICE_KINDS = ['generic', 'api', 'worker', 'external', 'scheduler', 'gateway'] as const;
export type ServiceKind = (typeof SERVICE_KINDS)[number];

export const DATABASE_KINDS = [
  'generic',
  'sql',
  'nosql',
  'cache',
  'file-system',
  'object-storage',
  'search-index',
  /** A logical table/collection *inside* a database — the Transactional Outbox's outbox row, a
   *  read model's projection table, a CDC source. Drawn as a flat table card, never a cylinder, so
   *  two tables in one boundary read as one database, not two. Folds to `database`. */
  'table',
] as const;
export type DatabaseKind = (typeof DATABASE_KINDS)[number];

export const QUEUE_KINDS = ['queue', 'topic', 'stream'] as const;
export type QueueKind = (typeof QUEUE_KINDS)[number];

/**
 * A node's role in a generated reliability topology — orthogonal to `QueueKind`'s "which
 * messaging paradigm" dimension. Purely descriptive, never a reference to another node (contrast
 * with a hypothetical `deadLetterDestination` pointer): the *relationship* to whichever queue
 * generated this one lives entirely on the connecting edge (`DraftEdge.semantic ===
 * 'deadLetters'`), so this field can never dangle or need cycle-repair. Set only by the "Add DLQ"
 * command (`store/editorStore.ts`'s `addDeadLetterQueue`) — deliberately excluded from
 * `ElementInspectorPopover`'s manual queue-kind picker, since it's a generated role, not a
 * user-chosen paradigm. One member today; the name stays generic for a future role (e.g. a retry
 * buffer) without redesign.
 */
export const DELIVERY_ROLES = ['dead-letter'] as const;
export type DeliveryRole = (typeof DELIVERY_ROLES)[number];

/** An Actor is any external participant interacting with the system being modelled — not
 *  human-only. */
export const ACTOR_KINDS = ['human', 'system', 'device'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

/**
 * A logical architectural building block that lives *inside* a larger deployment or boundary —
 * the deliberate counterpart to `Service`, which is Draft Canvas's deployable/runtime role.
 * Component carries none of Service's implications: no independent deployment, no network
 * boundary, no process boundary. "Use Cases," "a persistence adapter," an internal domain
 * module — a Component, never a Service, however service-like its name sounds.
 *
 * Kept deliberately small: `generic` (unspecified — no caption, same convention as every other
 * kind's default), `module` (an internal subdivision — the Modular Monolith starter's own
 * Customer/Orders/Payments are exactly this: named, sized modules living inside one deployment
 * boundary, never independently deployable), `adapter` (a ports-and-adapters translation layer —
 * Hexagonal's own use case, and also the Modular Monolith starter's inbound API), and `port` (a
 * *contract* — an interface the thing that owns it defines and something else implements or
 * calls: Hexagonal's inbound/outbound ports, a plugin boundary, a module's published interface).
 * Port is the one kind that is categorically not "a Component with a role": it isn't a thing that
 * does work, it's the shape of an agreement, and it takes part in different relationships than any
 * other kind (it is only ever called/used, and implemented — see `connectorSemantics.ts`'s `port`
 * category). Anything narrower than these four — "Repository," "Controller," "Use Case" — is a
 * *label* a user types onto a `generic` (or `adapter`) Component, never a fifth kind.
 */
export const COMPONENT_KINDS = ['generic', 'module', 'adapter', 'port'] as const;
export type ComponentKind = (typeof COMPONENT_KINDS)[number];

/** Loose, technology-neutral presets for a `group` boundary. A preset only
 *  changes a small secondary caption — never the node's own `text`. */
export const BOUNDARY_PRESETS = ['boundary', 'system', 'domain', 'network', 'deployment', 'group'] as const;
export type BoundaryPreset = (typeof BOUNDARY_PRESETS)[number];

/** Optional convenience defaults for a connection's label. Never mandatory,
 *  and never changes an edge's `accent` — see `document/edgeSemantics.ts`. */
export const EDGE_SEMANTICS = [
  'http',
  'grpc',
  'event',
  'command',
  'query',
  'reads',
  'writes',
  'publishes',
  'consumes',
  'calls',
  'dependsOn',
  'uses',
  'fansOut',
  'deliversTo',
  'ingests',
  'replicates',
  'cdc',
  'syncs',
  'deadLetters',
  'invalidates',
  'watches',
  'searches',
  'indexes',
  'routes',
  'triggers',
  'implementedBy',
  /** A compensating action: a new local transaction that semantically undoes an earlier one
   *  (a saga's "release payment" after "reserve payment"). A command in every other respect —
   *  offered where `command` is, never a rollback of anything. */
  'compensates',
  /** Materialising a read model from events or from the write side — a projection's write into a
   *  read store. Offered beside `writes` so the authoritative write and the derived one never read
   *  the same. */
  'projects',
] as const;
export type EdgeSemantic = (typeof EDGE_SEMANTICS)[number];

/**
 * A connector's flow behaviour — a lightweight, developer-facing vocabulary,
 * not UML/BPMN notation. Independent of `semantic` (what the connection
 * carries, a label convenience) and `async` (the solid/dashed line — `kind:
 * 'async'` defaults it to `true` the way a semantic defaults a label, but
 * never forces it, and either can still be changed on its own afterward).
 * `'event'` exists in both this list and `EDGE_SEMANTICS` — coincidence, not
 * a shared field; a connector can be `semantic: 'event'` and `kind: 'retry'`
 * at once.
 */
export const CONNECTOR_KINDS = [
  'sync',
  'async',
  'event',
  'callback',
  'conditional',
  'retry',
  'failure',
  'fallback',
] as const;
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];

/** Node types that can be folded into another node as an attachment. */
export const ATTACHABLE_TYPES = ['code', 'note', 'text'] as const;
export type AttachableType = (typeof ATTACHABLE_TYPES)[number];

/**
 * Supporting detail folded into a host node rather than left as an independent
 * canvas element. Deliberately a small, closed subset of `DraftNode`'s own
 * fields — an attachment is "the content of a Code/Note node, minus the
 * fields that only make sense for something living on the canvas" (position,
 * z-order, parentage). See `docs/ARCHITECTURE.md` for why this is an embedded
 * array on the host rather than a second kind of graph node.
 */
export interface Attachment {
  id: string;
  type: AttachableType;
  text?: string;
  noteKind?: NoteKind;
  language?: CodeLanguage;
  code?: string;
  accent?: Accent;
  /** Preserved from the source node so detaching restores its size, not a default. */
  width?: number;
  height?: number;
}

export interface DraftNode {
  id: string;
  type: DraftNodeType;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Stacking order. Groups are forced behind their contents at render time. */
  z: number;
  /** Group membership. Coordinates stay absolute in the document model. */
  parentId?: string;
  /** The node's primary label. Always plain text — never HTML. */
  text?: string;
  /**
   * Whether `text` is a system-managed placeholder or a name the user chose — the same
   * "may this be silently recomputed?" question `DraftEdge.semanticsOrigin` answers for an edge's
   * `semantic`, applied to a node's label instead. `'auto'`: `createNode` set `text` from a type/kind
   * default because the caller didn't supply one — `service` nodes' `updateNodeById` handler may
   * still overwrite it to follow a later `serviceKind` change (see `store/editorStore.ts`).
   * `'explicit'`: the user typed something (`updateNodeText`) or a caller passed `text` on purpose —
   * permanent from that point on, even if the typed value happens to match a default. Absent (every
   * node saved before this field existed): treated as `'explicit'` — a name Draft Canvas can't prove
   * was auto-generated is never safe to silently rewrite.
   */
  textOrigin?: 'auto' | 'explicit';
  accent?: Accent;
  /** `note` nodes only. */
  noteKind?: NoteKind;
  /** `code` nodes only. */
  language?: CodeLanguage;
  code?: string;
  /** `service` nodes only. */
  serviceKind?: ServiceKind;
  /** `database` nodes only. */
  databaseKind?: DatabaseKind;
  /** `queue` nodes only. */
  queueKind?: QueueKind;
  /** `actor` nodes only. */
  actorKind?: ActorKind;
  /** `component` nodes only. */
  componentKind?: ComponentKind;
  /** `group` nodes only. */
  boundaryPreset?: BoundaryPreset;
  /** Supporting detail collapsed into this node. Any node type may host one. */
  attachments?: Attachment[];
  /** `queue` nodes only — see `DeliveryRole`. */
  deliveryRole?: DeliveryRole;
  /**
   * `text` nodes only. A quieter rendering for a Label used as a small architectural aside (e.g.
   * naming the crossing point of a boundary) rather than genuine content someone is meant to read
   * at normal weight — smaller, muted text, still zero-semantics, still no box. Absent/`false` is
   * the Label primitive's one existing look, unchanged; this never affects any other node type.
   * Superseded by `textRole` going forward (see below) but kept exactly as-is: every starter in
   * `src/starters/catalog.ts` still sets this, not `textRole`, and must keep rendering unchanged.
   */
  annotation?: boolean;
  /**
   * `text` nodes only. The semantic hierarchy a Text element communicates — see `TextRole`. Absent
   * falls back to `annotation ? 'label' : 'body'` (`nodes/describe.ts`'s `effectiveTextRole`), so
   * every node saved before this field existed, `annotation` included, renders exactly as it did.
   * An explicit `textRole` always wins over a legacy `annotation` flag if a node somehow has both.
   */
  textRole?: TextRole;
  /** `text` nodes only. Absent is `'left'`, today's one existing alignment. */
  textAlign?: TextAlign;
  /** `text` nodes only. Independent of `textRole` — combines with any role, including `technical`. */
  textBold?: boolean;
  /** `text` nodes only. See `textBold`. */
  textItalic?: boolean;
}

export interface EdgeDetails {
  language: CodeLanguage;
  code: string;
}

export interface DraftEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  /** `false` renders a plain association line with no arrowhead. */
  directed: boolean;
  routing: EdgeRouting;
  accent?: Accent;
  /** Expandable technical detail, shown on selection and in Explain Mode. */
  details?: EdgeDetails;
  /**
   * Optional convenience type. Provides a default label when the edge has
   * none; never implies or changes `accent` or any other styling.
   */
  semantic?: EdgeSemantic;
  /**
   * Free-text condition chip, e.g. "approved", "timeout". Distinct from
   * `label`: the label describes what the connection represents in general,
   * the condition describes when this particular branch applies. Never
   * evaluated — display only.
   */
  condition?: string;
  /**
   * Free-text response chip for a synchronous call, e.g. "200 Customer",
   * "404 Not Found". Distinct from `condition`: `condition` says *when* a
   * branch applies, `response` says what came back. Absent means "a plain
   * one-way connector, exactly as before this field existed" — it never
   * creates or implies a second edge; it renders as a quieter secondary line
   * reusing this same connector's own geometry (see `edges/routing.ts`'s lane
   * trick). Never evaluated, and deliberately never persists a
   * success/failure distinction — `kind: 'failure'` already exists as a
   * whole-connector visual treatment for that. `document/connectorSemantics.ts`'s
   * `isSyncPairing` only gates whether the *authoring* UI offers this field,
   * never whether an existing value renders.
   */
  response?: string;
  /**
   * Whether this connector draws its quiet reply line at all, independent of
   * `response`'s text. Absent/`false` means a plain one-way connector, exactly
   * as before this field existed. `true` with `response` unset draws the line
   * with no label yet; `response` text should never appear with this `false`
   * (a hand-edited file that does so still renders no label — this field is
   * the sole gate for the line's existence, not a derived value from
   * `response`'s truthiness). Defaulted `true` by `connect()`/`reconnectEdge()`
   * only for a service↔service (or service↔external) pairing — see
   * `connectorSemantics.ts`'s `defaultsToResponse` — never for `actor>service`.
   * A manual toggle (`setEdgeHasResponse`) stamps `semanticsOrigin: 'explicit'`,
   * the same discipline `setEdgeSemantic`/`setEdgeKind` already follow, so an
   * explicit "no response" survives a later reconnect.
   */
  hasResponse?: boolean;
  /** Flow behaviour — see `ConnectorKind`. Optional; a plain connection has none. */
  kind?: ConnectorKind;
  /** `true` renders a dashed line for an asynchronous interaction. Absent/`false` is synchronous (solid). */
  async?: boolean;
  /**
   * Where this connector actually starts/ends, captured from the side the
   * user dragged from/dropped onto. Absent means "never explicitly chosen" —
   * routing falls back to picking the nearest sides itself (`chooseSides` in
   * `edges/routing.ts`), exactly as every edge behaved before this field
   * existed. Once set, routing must not silently move it; only an explicit
   * reconnect changes it.
   */
  sourceAnchor?: EdgeAnchor;
  targetAnchor?: EdgeAnchor;
  /**
   * Set only once the user has explicitly taken this connector's routing into
   * their own hands — "auto until touched". Absent, the router is free to
   * bundle it into a shared fan-out/fan-in trunk (`edges/bundles.ts`);
   * `'direct'` opts it out and routes it on its own, exactly as every
   * connector did before Smart Routing existed.
   *
   * Note this is about *how much freedom the router has*, not about line
   * style — that's `routing` above, which stays independent. A `'direct'`
   * connector is still a smoothstep/bezier/straight one.
   */
  routeMode?: RouteMode;
  /**
   * Whether `semantic`/`kind` were set by `connectorSemantics.ts`'s inference
   * or chosen by the user. Absent means "never explicitly chosen" — the same
   * convention `sourceAnchor`/`targetAnchor` use — so a file saved before this
   * field existed, even one with a manually-picked `semantic`, is treated as
   * explicit (see `isEligibleForReinference` in `document/connectorSemantics.ts`)
   * and never silently rewritten. Only a fresh inference stamps `'inferred'`;
   * only `setEdgeSemantic`/`setEdgeKind` stamp `'explicit'`.
   */
  semanticsOrigin?: 'inferred' | 'explicit';
  /**
   * Supporting detail (a note, or a code/JSON snippet) hidden by default and revealed on hover or
   * selection — see `EdgeAttachmentReveal` in `DraftEdgeView.tsx`. The exact same `Attachment`
   * type a node uses, reused rather than duplicated; an array for the same reason node attachments
   * are, though the toolbar and reveal card only ever create or show the first entry in v1. Kept
   * entirely separate from the older, narrower `details` field above (which stays exactly as it
   * was — the one thing that already reads it, `FlowBar.tsx`'s playback panel, must keep working
   * unchanged) rather than trying to unify the two for a feature that never wrote `details` anyway.
   */
  attachments?: Attachment[];
  /**
   * How many delivery attempts occur before this edge's failure route is taken — only meaningful
   * alongside `semantic: 'deadLetters'`, same convention as `response` being only meaningful
   * alongside `hasResponse`. Deliberately not called `retryAttempts`: the actual mechanism behind
   * an "attempt" (broker redelivery, a visibility-timeout re-queue, consumer-side retry, an
   * explicit republish) varies by messaging technology, and Draft Canvas models architectural
   * intent, not a specific broker's retry implementation. Rendered as a caption, e.g. "after 3
   * attempts" — see `document/edgeSemantics.ts`'s `relationshipCaptionLabel`.
   */
  deliveryAttempts?: number;
}

/**
 * One step in a Flow, in order, optionally with a caption specific to this
 * telling of the story. `caption` falls back to the primary edge's own
 * `label` when absent — the label describes the connection in general, the
 * caption explains what's happening at this point in this flow.
 *
 * `edgeId` is a step's primary connector — the one thing every step had
 * before `extraNodeIds`/`extraEdgeIds` existed, and still the only thing
 * most steps need. It is optional now specifically so a "frame" step can
 * spotlight a group of nodes with no single connector driving it (a system
 * overview, a boundary, a scenario's starting state) — a genuinely different
 * kind of step, not a variant of `FocusState` (arbitrary, unordered,
 * available in edit mode too) or `FlowPlaybackState` (which this *is* an
 * ordered member of) — see `docs/ARCHITECTURE.md`.
 */
export interface DraftFlowStep {
  id: string;
  edgeId?: string;
  /** Additional connectors this step highlights, beyond the primary one. */
  extraEdgeIds?: string[];
  /** Additional nodes this step highlights, beyond the primary connector's own endpoints. */
  extraNodeIds?: string[];
  /** An explicit viewport this step shows verbatim — auto-fit-to-bounds is
   *  skipped entirely when present. */
  viewport?: DraftViewport;
  caption?: string;
}

/**
 * A named, ordered walkthrough of existing connectors — an explanation layer
 * over the architecture, not a second copy of it. Multiple flows may share or
 * diverge on the same connectors; order comes from array position, not a
 * field on the edge, which is what lets one connector belong to several
 * flows at different positions simultaneously. See `document/flow.ts`.
 */
export interface DraftFlow {
  id: string;
  title: string;
  steps: DraftFlowStep[];
  /**
   * Optional identity colour, applied to this flow's member connectors only
   * while the flow is the active lens (selected or presenting) — never a
   * permanent per-edge colour, since a connector can belong to several flows
   * at once. Absent renders exactly as before this field existed: every
   * member connector keeps its own normal styling. Same restrained `Accent`
   * vocabulary as nodes/edges, not a colour picker.
   */
  accent?: Accent;
}

export interface DraftViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface DraftMetadata {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** The project this canvas belongs to, if any — see `Project`. A canvas
   *  belongs to zero or one project; absent means Unorganized. */
  projectId?: string;
}

/**
 * A lightweight, flat collection of canvases — deliberately not a folder:
 * no nesting, no canvas belonging to more than one. Exists purely so the
 * library can group diagrams once they number in the dozens or hundreds,
 * never to gate creating one.
 */
export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Phase 5.1 — a decorative, canvas-layer backdrop. Presentation knobs only:
 * the image bytes themselves live in a dedicated IndexedDB store, keyed by
 * this document's id (see `storage/IndexedDbRepository.ts`), never inline
 * here — `localStorage`-style inlining would duplicate large binary data
 * across every save. `enabled: true` with no matching stored row (corruption,
 * a duplicate that failed to copy) degrades to "no background shown," never
 * an error — the same repair-don't-reject discipline as the rest of this file.
 */
export interface BackgroundSettings {
  enabled: boolean;
  fit: BackgroundFit;
  /** Scrim opacity over the image, 0 (none) – 1 (fully obscured). */
  dim: number;
  /** 0 (none) – 1 (maximum), mapped to a CSS/SVG blur radius at render time. */
  blur: number;
}

export interface DraftSettings {
  /** Whether to show a flow's step badges on its connectors when it's selected for overlay. */
  showSequence: boolean;
  grid: GridMode;
  background: BackgroundSettings;
}

export interface DraftDocument {
  format: DraftFormat;
  /** The document's schema version — see `CURRENT_VERSION` and `migrate.ts`.
   *  Deliberately independent of the app's own version (`PRODUCT.version`,
   *  Phase 6): a diagram written by an old build stays readable by opening it
   *  through the migrations below, with no relation to which app release
   *  wrote it. */
  version: number;
  metadata: DraftMetadata;
  nodes: DraftNode[];
  edges: DraftEdge[];
  viewport: DraftViewport;
  settings: DraftSettings;
  flows: DraftFlow[];
}

/** Bump when `libraryShapeOf` changes what it records — the only lever for
 *  re-deriving every stored `LibraryShape` without a database version bump. */
export const SHAPE_VERSION = 1;

/** The nine silhouettes a library fingerprint distinguishes — `categoryOf`'s
 *  eighteen categories folded to what is still legible at a few pixels. */
export type ShapeKind =
  | 'service'
  | 'external'
  | 'database'
  | 'queue'
  | 'topic'
  | 'actor'
  | 'component'
  | 'junction'
  | 'boundary';

/**
 * A canvas's topology, reduced to what makes it recognisable in a list: each
 * architectural node's kind and box (integers, scaled so the longer axis of
 * the content is 1000) and which of them are connected. No text of any kind.
 * See `document/shape.ts`.
 */
export interface LibraryShape {
  v: number;
  w: number;
  h: number;
  nodes: Array<[kind: ShapeKind, x: number, y: number, w: number, h: number]>;
  edges: Array<[from: number, to: number]>;
}

/**
 * Lightweight row for the local library listing. Never holds canvas text.
 *
 * `shape` is the one body-derived field, and it is stored in the plaintext
 * `documents` store alongside the title on purpose: it holds node kinds and
 * relative positions only — never a label, a note, a code card, or a
 * connector's words — and reading every encrypted body just to draw the
 * list would make the landing screen sluggish. Anything that would widen
 * this beyond silhouettes belongs in the encrypted body.
 */
export interface DraftSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  nodeCount: number;
  edgeCount: number;
  /** Denormalized from `DraftMetadata.projectId` — see `summarize()`. */
  projectId?: string;
  /** Absent for a canvas with no nodes, or one summarised by an older build
   *  (backfilled once at startup — see `IndexedDbRepository.backfillSummaries`). */
  shape?: LibraryShape;
}
