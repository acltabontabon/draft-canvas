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
export const CURRENT_VERSION = 9;

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
] as const;

export type DraftNodeType = (typeof NODE_TYPES)[number];

export const NOTE_KINDS = ['note', 'question', 'warning', 'decision'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

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
export const SERVICE_KINDS = ['generic', 'api', 'worker', 'external'] as const;
export type ServiceKind = (typeof SERVICE_KINDS)[number];

export const DATABASE_KINDS = ['generic', 'sql', 'nosql', 'cache'] as const;
export type DatabaseKind = (typeof DATABASE_KINDS)[number];

export const QUEUE_KINDS = ['queue', 'topic', 'stream'] as const;
export type QueueKind = (typeof QUEUE_KINDS)[number];

/** An Actor is any external participant interacting with the system being modelled — not
 *  human-only. */
export const ACTOR_KINDS = ['human', 'system', 'device'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

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
  'fansOut',
  'deliversTo',
  'ingests',
  'replicates',
  'cdc',
  'syncs',
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
  /** `group` nodes only. */
  boundaryPreset?: BoundaryPreset;
  /** Supporting detail collapsed into this node. Any node type may host one. */
  attachments?: Attachment[];
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

/** Lightweight row for the local library listing. Never holds canvas contents. */
export interface DraftSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  nodeCount: number;
  edgeCount: number;
  /** Denormalized from `DraftMetadata.projectId` — see `summarize()`. */
  projectId?: string;
}
