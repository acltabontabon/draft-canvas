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
export const CURRENT_VERSION = 3;

export type DraftFormat = typeof DRAFT_FORMAT;

/**
 * The node vocabulary is intentionally small. Developer presets (service,
 * database, queue, actor) are distinct types rather than styled cards because
 * they carry recognisable silhouettes, but they share one renderer and one set
 * of behaviours.
 */
export const NODE_TYPES = [
  'card',
  'rounded',
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

/** Sub-kinds of the developer presets. Purely a labelling convenience — the
 *  base type's silhouette and accent always dominate; see `nodes/describe.ts`. */
export const SERVICE_KINDS = ['generic', 'api', 'worker', 'external'] as const;
export type ServiceKind = (typeof SERVICE_KINDS)[number];

export const DATABASE_KINDS = ['generic', 'sql', 'nosql', 'cache'] as const;
export type DatabaseKind = (typeof DATABASE_KINDS)[number];

export const QUEUE_KINDS = ['queue', 'topic', 'stream'] as const;
export type QueueKind = (typeof QUEUE_KINDS)[number];

/** Loose, technology-neutral presets for a `group` boundary. A preset only
 *  changes a small secondary caption — never the node's own `text`. */
export const BOUNDARY_PRESETS = ['boundary', 'system', 'domain', 'network', 'deployment', 'group'] as const;
export type BoundaryPreset = (typeof BOUNDARY_PRESETS)[number];

/** Optional convenience defaults for a connection's label. Never mandatory,
 *  and never changes an edge's `accent` — see `document/edgeSemantics.ts`. */
export const EDGE_SEMANTICS = [
  'http',
  'event',
  'command',
  'query',
  'reads',
  'writes',
  'publishes',
  'consumes',
  'calls',
  'dependsOn',
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
export const ATTACHABLE_TYPES = ['code', 'note', 'text', 'card', 'rounded'] as const;
export type AttachableType = (typeof ATTACHABLE_TYPES)[number];

/**
 * Supporting detail folded into a host node rather than left as an independent
 * canvas element. Deliberately a small, closed subset of `DraftNode`'s own
 * fields — an attachment is "the content of a Code/Note/Card node, minus the
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
}

export interface DraftSettings {
  /** Whether to show a flow's step badges on its connectors when it's selected for overlay. */
  showSequence: boolean;
  grid: GridMode;
}

export interface DraftDocument {
  format: DraftFormat;
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
}
