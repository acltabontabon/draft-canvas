import type {
  ActorKind,
  BoundaryPreset,
  ComponentKind,
  DatabaseKind,
  NoteKind,
  QueueKind,
  ServiceKind,
} from '../../document/types';

/**
 * Per-type option labels for a node's "kind"/preset field — shared between `Inspector.tsx`'s
 * multi-selection bar and `ElementInspectorPopover`'s single-element compact row, which both need
 * the exact same option lists so the two surfaces can't drift apart. Split into its own module
 * (rather than exported from either component) so both keep fast refresh working.
 */
export const NOTE_LABELS: Record<NoteKind, string> = {
  note: 'Note',
  question: 'Question',
  warning: 'Warning',
  decision: 'Decision',
};

export const BOUNDARY_PRESET_OPTION_LABELS: Record<BoundaryPreset, string> = {
  boundary: 'Boundary',
  system: 'System',
  domain: 'Domain',
  network: 'Network',
  deployment: 'Deployment',
  group: 'Group',
};

export const SERVICE_KIND_OPTION_LABELS: Record<ServiceKind, string> = {
  generic: 'Generic',
  api: 'API',
  worker: 'Worker',
  external: 'External',
  scheduler: 'Scheduler',
  gateway: 'Gateway',
};

export const DATABASE_KIND_OPTION_LABELS: Record<DatabaseKind, string> = {
  generic: 'Generic',
  sql: 'SQL',
  nosql: 'NoSQL',
  cache: 'Cache',
  'file-system': 'File System',
  'object-storage': 'Object Storage',
  'search-index': 'Search Index',
};

export const QUEUE_KIND_OPTION_LABELS: Record<QueueKind, string> = {
  queue: 'Queue',
  topic: 'Topic',
  stream: 'Stream',
};

export const ACTOR_KIND_OPTION_LABELS: Record<ActorKind, string> = {
  human: 'Human',
  system: 'System',
  device: 'Device',
};

export const COMPONENT_KIND_OPTION_LABELS: Record<ComponentKind, string> = {
  generic: 'Generic',
  module: 'Module',
  adapter: 'Adapter',
};
