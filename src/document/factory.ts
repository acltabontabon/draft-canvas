import { createId } from './ids';
import { DEFAULTS } from './limits';
import {
  CURRENT_VERSION,
  DRAFT_FORMAT,
  type Accent,
  type AttachableType,
  type Attachment,
  type BoundaryPreset,
  type CodeLanguage,
  type DatabaseKind,
  type DraftDocument,
  type DraftEdge,
  type DraftNode,
  type DraftNodeType,
  type NoteKind,
  type QueueKind,
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
      return { width: 72, height: 72 };
    case 'actor':
      return { width: 64, height: 72 };
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

export function defaultTextFor(type: DraftNodeType): string {
  switch (type) {
    case 'service':
      return 'Service';
    case 'database':
      return 'Database';
    case 'queue':
      return 'Topic';
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
  parentId?: string;
  id?: string;
}

export function createNode(input: CreateNodeInput): DraftNode {
  const size = defaultSizeFor(input.type);
  const node: DraftNode = {
    id: input.id ?? createId('n'),
    type: input.type,
    x: input.x,
    y: input.y,
    width: input.width ?? size.width,
    height: input.height ?? size.height,
    z: input.z ?? 0,
    text: input.text ?? defaultTextFor(input.type),
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
  if (input.width !== undefined && input.height !== undefined) {
    attachment.width = input.width;
    attachment.height = input.height;
  }
  return attachment;
}

export interface CreateEdgeInput {
  source: string;
  target: string;
  label?: string;
  directed?: boolean;
  routing?: DraftEdge['routing'];
  accent?: Accent;
  sequence?: number;
  id?: string;
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
  if (input.accent !== undefined) edge.accent = input.accent;
  if (typeof input.sequence === 'number') edge.sequence = input.sequence;
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
    settings: { showSequence: true, grid: 'dots' },
  };
}

/** A deep copy with fresh identity, used by "Duplicate" in the library. */
export function cloneDocumentAsNew(doc: DraftDocument, title: string): DraftDocument {
  const now = Date.now();
  return {
    ...structuredClone(doc),
    metadata: { id: createId('d'), title, createdAt: now, updatedAt: now },
  };
}
