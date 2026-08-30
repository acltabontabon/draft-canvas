import { createId } from './ids';
import { DEFAULTS } from './limits';
import {
  CURRENT_VERSION,
  DRAFT_FORMAT,
  type Accent,
  type CodeLanguage,
  type DraftDocument,
  type DraftEdge,
  type DraftNode,
  type DraftNodeType,
  type NoteKind,
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
  if (input.accent && input.accent !== 'neutral') node.accent = input.accent;
  if (input.parentId) node.parentId = input.parentId;
  if (input.type === 'note') node.noteKind = input.noteKind ?? 'note';
  if (input.type === 'code') {
    node.language = input.language ?? 'plaintext';
    node.code = input.code ?? '';
  }
  return node;
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
  if (input.accent && input.accent !== 'neutral') edge.accent = input.accent;
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
