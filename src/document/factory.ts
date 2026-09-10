import { createId } from './ids';
import { DEFAULTS } from './limits';
import {
  CURRENT_VERSION,
  DRAFT_FORMAT,
  type Accent,
  type ActorKind,
  type AttachableType,
  type Attachment,
  type BoundaryPreset,
  type CodeLanguage,
  type ComponentKind,
  type ConnectorKind,
  type DatabaseKind,
  type DeliveryRole,
  type DraftDocument,
  type DraftEdge,
  type DraftNode,
  type DraftNodeType,
  type EdgeAnchor,
  type EdgeSemantic,
  type NoteKind,
  type QueueKind,
  type RouteMode,
  type ServiceKind,
} from './types';

export function defaultSizeFor(type: DraftNodeType): { width: number; height: number } {
  switch (type) {
    case 'code':
      return { width: DEFAULTS.codeWidth, height: DEFAULTS.codeHeight };
    case 'note':
      return { width: DEFAULTS.noteWidth, height: DEFAULTS.noteHeight };
    case 'text':
      return { width: DEFAULTS.textWidth, height: DEFAULTS.textHeight };
    case 'ellipse':
      return { width: DEFAULTS.ellipseWidth, height: DEFAULTS.ellipseHeight };
    case 'group':
      return { width: DEFAULTS.groupWidth, height: DEFAULTS.groupHeight };
    case 'actor':
      return { width: DEFAULTS.actorWidth, height: DEFAULTS.actorHeight };
    case 'database':
      return { width: DEFAULTS.dataStoreWidth, height: DEFAULTS.dataStoreHeight };
    case 'queue':
      return { width: DEFAULTS.queueWidth, height: DEFAULTS.queueHeight };
    case 'component':
      return { width: DEFAULTS.componentWidth, height: DEFAULTS.componentHeight };
    default:
      return { width: DEFAULTS.nodeWidth, height: DEFAULTS.nodeHeight };
  }
}

/**
 * Interactive resize floors. Deliberately separate from `LIMITS.minNodeSize` (the
 * hard, type-agnostic floor `clampSize` enforces on any write, including file
 * import): these are the more generous, per-type minimums `NodeResizer` uses so a
 * database cylinder or an actor's head-and-shoulders never resizes into a shape
 * that stops reading as its type.
 */
export function minSizeFor(type: DraftNodeType): { width: number; height: number } {
  switch (type) {
    case 'text':
      return { width: 80, height: 28 };
    case 'ellipse':
      return { width: 24, height: 24 };
    case 'actor':
      return { width: 88, height: 84 };
    case 'queue':
      return { width: 120, height: 40 };
    case 'database':
      return { width: 120, height: 76 };
    case 'note':
      return { width: 120, height: 72 };
    case 'code':
      return { width: 200, height: 96 };
    case 'group':
      return { width: 160, height: 120 };
    default:
      return { width: 96, height: 48 };
  }
}

/**
 * Interactive resize ceiling. Unlike `minSizeFor`, most types have none — only
 * Junction (`ellipse`) does, so a routing point can't be dragged back into the
 * large, ambiguous "Circle" shape it used to be.
 */
export function maxSizeFor(type: DraftNodeType): { width: number; height: number } | undefined {
  switch (type) {
    case 'ellipse':
      return { width: 64, height: 64 };
    default:
      return undefined;
  }
}

/**
 * `serviceKind`/`componentKind` only matter for their own type — every kind gets its own default
 * name (see `SERVICE_KIND_NAMES`/`COMPONENT_KIND_NAMES`) rather than the generic literal, so a
 * fresh Worker/API/Adapter/etc. starts out named for what it *is*, not for its family. Ignored for
 * every other type.
 */
export function defaultTextFor(type: DraftNodeType, serviceKind?: ServiceKind, componentKind?: ComponentKind): string {
  switch (type) {
    case 'service':
      return SERVICE_KIND_NAMES[serviceKind ?? 'generic'];
    case 'component':
      return COMPONENT_KIND_NAMES[componentKind ?? 'generic'];
    case 'database':
      return 'Data Store';
    case 'queue':
      return '';
    case 'actor':
      return 'User';
    case 'group':
      return 'Boundary';
    case 'note':
      return '';
    case 'code':
      return '';
    default:
      return '';
  }
}

const QUEUE_KIND_NAMES: Record<QueueKind, string> = { queue: 'Queue', topic: 'Topic', stream: 'Stream' };
/**
 * Doubles as both the fallback display name (`displayNameFor`, below) and the auto-generated
 * primary label a fresh Service node starts with (`createNode`) — one table, so the two can't
 * drift. "External System" (not "External service") reads as a component name, not a sentence
 * fragment, when it stands alone as a node's whole label.
 */
const SERVICE_KIND_NAMES: Record<ServiceKind, string> = {
  generic: 'Service',
  api: 'API',
  worker: 'Worker',
  external: 'External System',
  scheduler: 'Scheduler',
  gateway: 'Gateway',
};
const DATABASE_KIND_NAMES: Partial<Record<DatabaseKind, string>> = {
  sql: 'SQL data store',
  nosql: 'NoSQL data store',
  cache: 'Cache',
  'file-system': 'File system storage',
  'object-storage': 'Object storage',
  'search-index': 'Search index',
};
const ACTOR_KIND_NAMES: Record<ActorKind, string> = { human: 'Human', system: 'System', device: 'Device' };
/** Doubles as the fallback display name and the auto-generated label a fresh Component starts
 *  with — same one-table discipline as `SERVICE_KIND_NAMES`. */
const COMPONENT_KIND_NAMES: Record<ComponentKind, string> = {
  generic: 'Component',
  module: 'Module',
  adapter: 'Adapter',
  port: 'Port',
};

/**
 * A human-readable fallback identity for a node with no custom `text` of its
 * own. A Queue's name is *always* just its kind (see `DraftNodeView.tsx`'s
 * text-edit gate — there is no text field to type into), and Note/Code/a
 * fresh boundary are commonly left blank too, relying on their on-canvas
 * kind caption for identity instead (`nodes/describe.ts`). Anywhere a node
 * must be named in a list — the Flow panel, Presentation Mode's step
 * breadcrumb — needs that same fallback, not a bare "Untitled".
 */
export function displayNameFor(
  node: Pick<
    DraftNode,
    'type' | 'text' | 'queueKind' | 'serviceKind' | 'databaseKind' | 'actorKind' | 'componentKind'
  >,
): string {
  if (node.text && node.text.trim()) return node.text;
  switch (node.type) {
    case 'queue':
      return QUEUE_KIND_NAMES[node.queueKind ?? 'queue'];
    case 'service':
      return (node.serviceKind && SERVICE_KIND_NAMES[node.serviceKind]) || 'Service';
    case 'component':
      return (node.componentKind && COMPONENT_KIND_NAMES[node.componentKind]) || 'Component';
    case 'database':
      return (node.databaseKind && DATABASE_KIND_NAMES[node.databaseKind]) || 'Data Store';
    case 'actor':
      return (node.actorKind && ACTOR_KIND_NAMES[node.actorKind]) || 'Actor';
    case 'group':
      return 'Boundary';
    case 'note':
      return 'Note';
    case 'code':
      return 'Code';
    case 'text':
      return 'Text';
    case 'ellipse':
      return 'Junction';
    default:
      return 'Untitled';
  }
}

export interface CreateNodeInput {
  type: DraftNodeType;
  x: number;
  y: number;
  width?: number;
  height?: number;
  z?: number;
  text?: string;
  accent?: Accent;
  noteKind?: NoteKind;
  language?: CodeLanguage;
  code?: string;
  boundaryPreset?: BoundaryPreset;
  serviceKind?: ServiceKind;
  databaseKind?: DatabaseKind;
  queueKind?: QueueKind;
  actorKind?: ActorKind;
  componentKind?: ComponentKind;
  parentId?: string;
  id?: string;
  deliveryRole?: DeliveryRole;
  annotation?: boolean;
}

export function createNode(input: CreateNodeInput): DraftNode {
  const size = defaultSizeFor(input.type);
  const node: DraftNode = {
    id: input.id ?? createId('n'),
    type: input.type,
    x: input.x,
    y: input.y,
    width: input.width ?? size.width,
    // A queue-family node created *with* a name needs the taller box that fits the name and its
    // kind caption stacked under the tube — see `DEFAULTS.queueNamedHeight`.
    height:
      input.height ?? (input.type === 'queue' && input.text?.trim() ? DEFAULTS.queueNamedHeight : size.height),
    z: input.z ?? 0,
    text: input.text ?? defaultTextFor(input.type, input.serviceKind, input.componentKind),
    // A caller-supplied `text` is a deliberate name, kept forever. An omitted one is a
    // system-managed placeholder — `updateNodeById`'s Service auto-relabeling (`editorStore.ts`)
    // is the one place that later reads this to decide whether it may still follow the node's
    // `serviceKind` (see `DraftNode.textOrigin`'s own doc comment).
    textOrigin: input.text !== undefined ? 'explicit' : 'auto',
  };
  // `input.accent === 'neutral'` is an explicit choice to preserve (e.g.
  // duplicating a node the user deliberately made grey), not a synonym for
  // "no accent requested" — see the matching fix in `document/validate.ts`.
  if (input.accent !== undefined) node.accent = input.accent;
  if (input.parentId) node.parentId = input.parentId;
  if (input.type === 'note') node.noteKind = input.noteKind ?? 'note';
  if (input.type === 'code') {
    node.language = input.language ?? 'plaintext';
    node.code = input.code ?? '';
  }
  if (input.type === 'group') node.boundaryPreset = input.boundaryPreset ?? 'boundary';
  if (input.type === 'service') node.serviceKind = input.serviceKind ?? 'generic';
  if (input.type === 'database') node.databaseKind = input.databaseKind ?? 'generic';
  if (input.type === 'queue') node.queueKind = input.queueKind ?? 'queue';
  if (input.type === 'actor') node.actorKind = input.actorKind ?? 'human';
  if (input.type === 'component') node.componentKind = input.componentKind ?? 'generic';
  if (input.deliveryRole) node.deliveryRole = input.deliveryRole;
  if (input.type === 'text' && input.annotation) node.annotation = true;
  return node;
}

export interface CreateAttachmentInput {
  type: AttachableType;
  text?: string;
  accent?: Accent;
  noteKind?: NoteKind;
  language?: CodeLanguage;
  code?: string;
  width?: number;
  height?: number;
  id?: string;
}

/** Folds a node's own content fields into an attachment payload — the shape
 *  `attachToNode` expects when an existing canvas node is dragged in. */
export function createAttachment(input: CreateAttachmentInput): Attachment {
  const attachment: Attachment = { id: input.id ?? createId('a'), type: input.type };
  if (input.text !== undefined) attachment.text = input.text;
  if (input.accent !== undefined) attachment.accent = input.accent;
  if (input.type === 'note') attachment.noteKind = input.noteKind ?? 'note';
  if (input.type === 'code') {
    attachment.language = input.language ?? 'plaintext';
    attachment.code = input.code ?? '';
  }
  const size =
    input.width !== undefined && input.height !== undefined
      ? { width: input.width, height: input.height }
      : defaultSizeFor(input.type);
  attachment.width = size.width;
  attachment.height = size.height;
  return attachment;
}

export interface CreateEdgeInput {
  source: string;
  target: string;
  label?: string;
  /** A small, secondary annotation shown below the label — see `DraftEdge.condition`. */
  condition?: string;
  directed?: boolean;
  routing?: DraftEdge['routing'];
  accent?: Accent;
  id?: string;
  /** The side the user actually dragged the connection from/to, if known. */
  sourceAnchor?: EdgeAnchor;
  targetAnchor?: EdgeAnchor;
  kind?: ConnectorKind;
  semantic?: EdgeSemantic;
  hasResponse?: boolean;
  semanticsOrigin?: DraftEdge['semanticsOrigin'];
  /** Set only when the user has explicitly taken this connector's routing over
   *  — see `DraftEdge.routeMode`. */
  routeMode?: RouteMode;
  /** Born-dashed, e.g. a generated dead-letter route — every other edge in the app only ever
   *  gains `async` after creation, via `toggleEdgeAsync`/`setEdgeKind('async')`. */
  async?: boolean;
  deliveryAttempts?: number;
}

export function createEdge(input: CreateEdgeInput): DraftEdge {
  const edge: DraftEdge = {
    id: input.id ?? createId('e'),
    source: input.source,
    target: input.target,
    directed: input.directed ?? true,
    routing: input.routing ?? 'smoothstep',
  };
  if (input.label) edge.label = input.label;
  if (input.condition) edge.condition = input.condition;
  if (input.accent !== undefined) edge.accent = input.accent;
  if (input.sourceAnchor) edge.sourceAnchor = input.sourceAnchor;
  if (input.targetAnchor) edge.targetAnchor = input.targetAnchor;
  if (input.kind) edge.kind = input.kind;
  if (input.semantic) edge.semantic = input.semantic;
  if (input.hasResponse) edge.hasResponse = input.hasResponse;
  if (input.semanticsOrigin) edge.semanticsOrigin = input.semanticsOrigin;
  if (input.routeMode) edge.routeMode = input.routeMode;
  if (input.async) edge.async = true;
  if (input.deliveryAttempts !== undefined) edge.deliveryAttempts = input.deliveryAttempts;
  return edge;
}

export function createDocument(title = 'Untitled canvas'): DraftDocument {
  const now = Date.now();
  return {
    format: DRAFT_FORMAT,
    version: CURRENT_VERSION,
    metadata: { id: createId('d'), title, createdAt: now, updatedAt: now },
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    settings: {
      showSequence: true,
      grid: 'dots',
      background: { enabled: false, fit: 'cover', dim: 0.55, blur: 0 },
    },
    flows: [],
  };
}

/** A deep copy with fresh identity, used by "Duplicate" in the library. */
export function cloneDocumentAsNew(doc: DraftDocument, title: string): DraftDocument {
  const now = Date.now();
  return {
    ...structuredClone(doc),
    metadata: {
      id: createId('d'),
      title,
      createdAt: now,
      updatedAt: now,
      // Duplicate stays in the same project, same principle as carrying over
      // the background image — see `useDocumentSession.ts`'s `duplicateDocument`.
      ...(doc.metadata.projectId ? { projectId: doc.metadata.projectId } : {}),
    },
  };
}
