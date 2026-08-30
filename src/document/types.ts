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
export const CURRENT_VERSION = 1;

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

export const GRID_MODES = ['dots', 'lines', 'none'] as const;
export type GridMode = (typeof GRID_MODES)[number];

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
  /**
   * Position in the ordered walkthrough. `undefined` means the edge is not part
   * of the sequence. Numbers are kept contiguous from 1 by `sequence.ts`.
   */
  sequence?: number;
  /** Expandable technical detail, shown on selection and in Explain Mode. */
  details?: EdgeDetails;
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
