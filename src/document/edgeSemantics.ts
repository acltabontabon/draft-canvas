import type { NodeCategory } from './connectorSemantics';
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
export function relationshipCaptionLabel(semantic: EdgeSemantic, options: CaptionOptions = {}): string {
  const { hasResponse, deliveryAttempts, source, target } = options;
  if (hasResponse && semantic === 'calls') return 'requests';
  // A protocol-neutral count beats the generic label the moment one is set — "after 3 attempts"
  // says what's actually being modeled without claiming a specific retry mechanism. See
  // `DraftEdge.deliveryAttempts`'s own doc comment for why it isn't called `retryAttempts`.
  if (semantic === 'deadLetters' && deliveryAttempts) return `after ${deliveryAttempts} attempts`;
  return relationLabel(semantic, source, target);
}

/**
 * What a connector actually says on screen: the user's own label when there is one, otherwise the
 * relationship caption the canvas draws for it, otherwise nothing at all.
 *
 * One function because the words have to match wherever they appear — the canvas, the SVG
 * exporter, the presentation bar's caption and its spoken announcement, the Flow panel's step
 * list. Before this, the surfaces away from the canvas read `edge.label` raw, so a connector whose
 * meaning came from its `semantic` announced nothing while the canvas said "writes to".
 *
 * Three things it deliberately is not:
 *
 * - **Not `edgeRelationLabel`** (`connectorSemantics.ts`). That one calls `relationLabel`
 *   directly and so misses both of `relationshipCaptionLabel`'s relabels: a request/response
 *   `calls` connector reads "calls" there and "requests" on the canvas, and a dead-letter route
 *   with `deliveryAttempts` reads "dead-letters to" instead of "after 3 attempts".
 * - **Not junction-transparent.** Neither connector renderer resolves endpoints through a
 *   junction (see `DraftEdgeView.tsx`'s own note), so neither does this — matching what is drawn
 *   is the whole point.
 * - **Not `sequence/label.ts`'s `resolveMessageLabel`.** That one adds two further tiers that
 *   *invent* wording (the capability matrix's default relation, then a bare bucket word) because
 *   a sequence diagram must name every message. A connector that legitimately says nothing must
 *   keep saying nothing here.
 */
export function effectiveConnectorText(
  edge: {
    label?: string;
    semantic?: EdgeSemantic;
    hasResponse?: boolean;
    deliveryAttempts?: number;
  },
  endpoints: { source?: NodeCategory; target?: NodeCategory } = {},
): string | undefined {
  const explicit = edge.label?.trim();
  if (explicit) return explicit;
  if (!edge.semantic) return undefined;
  return relationshipCaptionLabel(edge.semantic, {
    hasResponse: edge.hasResponse,
    deliveryAttempts: edge.deliveryAttempts,
    source: endpoints.source,
    target: endpoints.target,
  });
}

/**
 * What a caption needs beyond the semantic itself. `source`/`target` are the connector's endpoint
 * categories (resolved through junctions where the caller has the graph) — without them the
 * caption falls back to the active wording, which is right for every arrow a doer starts.
 */
export interface CaptionOptions {
  hasResponse?: boolean;
  deliveryAttempts?: number;
  source?: NodeCategory;
  target?: NodeCategory;
}

/** Categories that hold data rather than act on it. */
export const STORE_CATEGORIES: ReadonlySet<NodeCategory> = new Set([
  'database',
  'cache',
  'fileSystem',
  'objectStorage',
  'searchIndex',
]);

/** Categories that carry messages rather than act on them. */
export const MESSAGING_CATEGORIES: ReadonlySet<NodeCategory> = new Set(['queue', 'topic', 'deadLetter']);

/**
 * A caption reads "source *verb* target", so it has to agree with the arrow. A semantic always
 * means the same relationship — `reads` is "a service reads a store" however the connector is
 * drawn — and when the arrow starts at the verb's *object* instead of its subject, the caption
 * switches to the passive: Database → Service `reads` is "read by", Queue → Worker `consumes` is
 * "consumed by". Display only: `semantic` is never rewritten, so a saved diagram drawn in the
 * data-flow direction reads correctly without touching the document.
 *
 * Verbs a holder performs itself (`deliversTo`, `fansOut`, `deadLetters`, `publishes` from object
 * storage, `replicates`, `syncs`, `cdc`, `transforms`) have no entry: they already read in the
 * arrow's direction.
 */
const PASSIVE: Partial<Record<EdgeSemantic, { label: string; when: 'sourceIsStore' | 'sourceIsMessaging' | 'sourceIsHolder' }>> = {
  reads: { label: 'read by', when: 'sourceIsStore' },
  writes: { label: 'written by', when: 'sourceIsStore' },
  query: { label: 'queried by', when: 'sourceIsStore' },
  searches: { label: 'searched by', when: 'sourceIsStore' },
  invalidates: { label: 'invalidated by', when: 'sourceIsStore' },
  watches: { label: 'watched by', when: 'sourceIsStore' },
  consumes: { label: 'consumed by', when: 'sourceIsMessaging' },
  ingests: { label: 'ingested by', when: 'sourceIsHolder' },
  indexes: { label: 'indexed by', when: 'sourceIsHolder' },
};

/** Whether a semantic has a passive reading at all — used by tests sweeping the matrix. */
export function hasPassiveReading(semantic: EdgeSemantic): boolean {
  return PASSIVE[semantic] !== undefined;
}

/** The plain caption for a semantic in the arrow's own direction — no response/attempts wording. */
export function relationLabel(semantic: EdgeSemantic, source?: NodeCategory, target?: NodeCategory): string {
  const passive = PASSIVE[semantic];
  if (passive && source !== undefined) {
    const isStore = STORE_CATEGORIES.has(source);
    const isMessaging = MESSAGING_CATEGORIES.has(source);
    const applies =
      passive.when === 'sourceIsStore' ? isStore : passive.when === 'sourceIsMessaging' ? isMessaging : isStore || isMessaging;
    // A store feeding another store (`reads` on Database → Database) has no subject on either
    // end to make passive about — keep the active form rather than guess.
    const targetActs = target === undefined || !(STORE_CATEGORIES.has(target) || MESSAGING_CATEGORIES.has(target));
    if (applies && (targetActs || passive.when === 'sourceIsHolder')) return passive.label;
  }
  return SEMANTIC_DEFAULTS[semantic].label;
}

export const SEMANTIC_DEFAULTS: Record<EdgeSemantic, { label: string }> = {
  http: { label: 'HTTP' },
  grpc: { label: 'gRPC' },
  event: { label: 'event' },
  command: { label: 'command' },
  query: { label: 'queries' },
  reads: { label: 'reads from' },
  writes: { label: 'writes to' },
  publishes: { label: 'publishes to' },
  consumes: { label: 'consumes from' },
  calls: { label: 'calls' },
  dependsOn: { label: 'depends on' },
  uses: { label: 'uses' },
  fansOut: { label: 'fans out to' },
  deliversTo: { label: 'delivers to' },
  ingests: { label: 'ingests' },
  replicates: { label: 'replicates to' },
  cdc: { label: 'CDC' },
  syncs: { label: 'syncs to' },
  deadLetters: { label: 'dead-letters to' },
  invalidates: { label: 'invalidates' },
  watches: { label: 'watches' },
  searches: { label: 'searches' },
  indexes: { label: 'indexes into' },
  routes: { label: 'routes to' },
  triggers: { label: 'triggers' },
  implementedBy: { label: 'implemented by' },
  compensates: { label: 'compensates' },
  transforms: { label: 'transforms' },
};
