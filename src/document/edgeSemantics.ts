import type { EdgeSemantic } from './types';

/**
 * Convenience defaults for a connection's optional semantic type — label
 * only, deliberately. Node colour already carries the primary semantic
 * weight in this app (Service teal, Database blue, Queue violet); having a
 * semantic also recolour the edge risked making diagrams noisier, not
 * clearer. See the callers in `store/editorStore.ts` for how (and when) this
 * is applied — only to fill an empty label, never to override one, and never
 * touching `accent`.
 *
 * `semantic` (this file), `kind` (`ConnectorKind` — see `edges/kindStyle.ts`),
 * and `async` are three independent dimensions on `DraftEdge`, not layers of
 * one taxonomy: `semantic` is what the connection carries (a label
 * convenience), `kind` is its flow behaviour (sync/async/event/callback/
 * conditional/retry/failure/fallback — visual line treatment), and `async` is
 * the plain solid/dashed line every edge already had. `kind: 'async'`
 * defaults `async` to `true` the same way a semantic defaults a label, but
 * setting one never reads, requires, or implies the other two.
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
