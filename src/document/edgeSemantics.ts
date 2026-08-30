import type { EdgeSemantic } from './types';

/**
 * Convenience defaults for a connection's optional semantic type — label
 * only, deliberately. Node colour already carries the primary semantic
 * weight in this app (Service teal, Database blue, Queue violet); having a
 * semantic also recolour the edge risked making diagrams noisier, not
 * clearer. See the callers in `store/editorStore.ts` for how (and when) this
 * is applied — only to fill an empty label, never to override one, and never
 * touching `accent`.
 */
export const SEMANTIC_DEFAULTS: Record<EdgeSemantic, { label: string }> = {
  http: { label: 'HTTP' },
  event: { label: 'event' },
  command: { label: 'command' },
  query: { label: 'query' },
  reads: { label: 'reads' },
  writes: { label: 'writes' },
  publishes: { label: 'publishes' },
  consumes: { label: 'consumes' },
  calls: { label: 'calls' },
  dependsOn: { label: 'depends on' },
};
