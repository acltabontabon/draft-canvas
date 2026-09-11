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
/**
 * The caption text for a connector's relationship — `SEMANTIC_DEFAULTS`'s own label, with one
 * deliberate relabel: a request/response connector (`hasResponse`) whose `semantic` is still the
 * untouched call default reads as "requests" rather than "calls" — the plain word "calls" doesn't
 * say anything the two-line request/response shape doesn't already say, while "requests" names
 * what's actually happening. Display only; `semantic` itself is never changed by this. Once the
 * user picks anything more specific (HTTP, gRPC, Command, Query, Event), that relation's own label
 * shows exactly as it does everywhere else. Shared by both connector renderers (`DraftEdgeView.tsx`
 * and `edges/describe.ts`) so they can't quietly disagree.
 */
export function relationshipCaptionLabel(
  semantic: EdgeSemantic,
  hasResponse?: boolean,
  deliveryAttempts?: number,
): string {
  if (hasResponse && semantic === 'calls') return 'requests';
  // A protocol-neutral count beats the generic label the moment one is set — "after 3 attempts"
  // says what's actually being modeled without claiming a specific retry mechanism. See
  // `DraftEdge.deliveryAttempts`'s own doc comment for why it isn't called `retryAttempts`.
  if (semantic === 'deadLetters' && deliveryAttempts) return `after ${deliveryAttempts} attempts`;
  return SEMANTIC_DEFAULTS[semantic].label;
}

export const SEMANTIC_DEFAULTS: Record<EdgeSemantic, { label: string }> = {
  http: { label: 'HTTP' },
  grpc: { label: 'gRPC' },
  event: { label: 'event' },
  command: { label: 'command' },
  query: { label: 'query' },
  reads: { label: 'reads' },
  writes: { label: 'writes' },
  publishes: { label: 'publishes' },
  consumes: { label: 'consumes' },
  calls: { label: 'calls' },
  dependsOn: { label: 'depends on' },
  uses: { label: 'uses' },
  fansOut: { label: 'fans out' },
  deliversTo: { label: 'delivers to' },
  ingests: { label: 'ingests' },
  replicates: { label: 'replicates to' },
  cdc: { label: 'CDC' },
  syncs: { label: 'syncs to' },
  deadLetters: { label: 'dead-letters to' },
  invalidates: { label: 'invalidates' },
  watches: { label: 'watches' },
  searches: { label: 'searches' },
  indexes: { label: 'indexes' },
  routes: { label: 'routes' },
  triggers: { label: 'triggers' },
  implementedBy: { label: 'implemented by' },
  compensates: { label: 'compensates' },
};
