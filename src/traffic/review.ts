import type { DraftEdge, DraftFlow, DraftNode } from '../document/types';
import { listOf, lostBy, outageNameOf, outageOf, type Outage } from './outage';
import type { TrafficAnalysis } from './types';

/**
 * The outage walk, asked of everything at once: what can this drawing not lose?
 *
 * It is the same reading as taking each shape, Boundary and connector down in turn (`outageOf`),
 * kept to what a review
 * needs from it — whom the failure reaches, which flows break, how many shapes it touches and how
 * many questions it leaves open. Nothing here is a new claim: every line is one a person would get
 * by taking that one thing down. So it carries no score and no severity. The order is what the drawing
 * says: what reaches a person first, then by the flows it breaks, then by how much else it touches.
 *
 * A Service drawn with several instances loses one, as the walk does, which is why drawing a
 * second instance takes a shape off this list. A Boundary is read as everything in it lost
 * together, and a connector as the route between two shapes lost while both stay up.
 *
 * Imports `document/` only: no React, store, canvas or DOM.
 */

export interface OutageReviewEntry {
  /** A shape or Boundary id, or for `connector` a connector's. */
  id: string;
  /** What is lost: one shape, everything a Boundary holds, or the route between two shapes. */
  kind: 'shape' | 'boundary' | 'connector';
  name: string;
  /** The shapes to point at for it: itself, its Boundary, or the two ends of the connector. */
  focus: string[];
  /** People and outside systems at the start of a chain that waits on it, who see the failure. */
  reaches: string[];
  /** Flows with a step that can no longer happen as drawn. */
  flows: { id: string; title: string }[];
  /** Shapes the outage changes, other than the one taken down. */
  affected: number;
  /** Questions the drawing leaves open about this outage. */
  questions: number;
  /** A few words for a list: "Shopper sees the failure · 2 flows break". */
  note: string;
  /** One plain sentence, in the diagram's own names. */
  text: string;
}

export interface OutageReview {
  /** Shapes and Boundaries whose loss changes something drawn, the ones that reach a person first. */
  entries: OutageReviewEntry[];
  /** Connectors whose loss changes something drawn, in the same order. Both ends stay up. */
  connectors: OutageReviewEntry[];
  /** Services drawn with several instances: losing one changes nothing drawn. */
  covered: { id: string; name: string; instances: number }[];
  /** Shapes that run and take part, whose loss changes nothing else drawn. */
  spared: { id: string; name: string }[];
}

export function outageReview(
  analysis: TrafficAnalysis,
  nodes: readonly DraftNode[],
  edges: readonly DraftEdge[],
  flows: readonly DraftFlow[] = [],
): OutageReview {
  const names = new Map(nodes.map((node) => [node.id, outageNameOf(node)]));
  const name = (id: string) => names.get(id) ?? 'Untitled';
  const review: OutageReview = { entries: [], connectors: [], covered: [], spared: [] };
  /**
   * What a review keeps of one reading, or `null` when losing it changes nothing else drawn.
   * `lead` opens its sentence: "Without Orders", "If Checkout can't reach Orders".
   */
  const entryOf = (outage: Outage, kind: OutageReviewEntry['kind'], label: string, lead: string): OutageReviewEntry | null => {
    let affected = 0;
    const reaches: string[] = [];
    for (const [id, state] of outage.nodes) {
      if (state === 'unaffected' || state === 'down') continue;
      affected += 1;
      if (state === 'failing' && analysis.nodes.get(id)?.role === 'origin') reaches.push(id);
    }
    const broken = outage.flows.filter((flow) => flow.state === 'breaks').map((flow) => ({ id: flow.id, title: flow.title }));
    const questions = outage.notes.filter((note) => note.tone === 'question').length;
    if (affected === 0 && broken.length === 0 && (kind !== 'connector' || questions === 0)) return null;
    const seen = reaches.map(name);
    // One shape lost leaves "other" shapes; a Boundary or a connector lost is not itself a shape.
    const shapes = `${affected} ${kind === 'shape' ? 'other ' : ''}${affected === 1 ? 'shape' : 'shapes'}`;
    const short = [
      ...(seen.length > 0 ? [`${listOf(seen, 2)} ${seen.length === 1 ? 'sees' : 'see'} the failure`] : affected > 0 ? [`${shapes} affected`] : []),
      ...(broken.length > 0 ? [`${broken.length} ${broken.length === 1 ? 'flow breaks' : 'flows break'}`] : []),
    ];
    const parts = [
      ...(seen.length > 0 ? [`${listOf(seen)} ${seen.length === 1 ? 'sees' : 'see'} the failure`] : affected > 0 ? [`${shapes} ${affected === 1 ? 'is' : 'are'} affected, and no one drawn waits on the result`] : []),
      ...(broken.length > 0 ? [`${listOf(broken.map((flow) => flow.title))} ${broken.length === 1 ? 'breaks' : 'break'}`] : []),
    ];
    // A severed route that changes nothing drawn can still leave its question.
    const nothing = 'nothing else drawn changes';
    const open = questions === 0 ? '' : ` The drawing leaves ${questions} ${questions === 1 ? 'question' : 'questions'} open.`;
    return {
      id: outage.target,
      kind,
      name: label,
      focus: outage.connector ? [...outage.connector.from, ...outage.connector.to] : [outage.target],
      reaches,
      flows: broken,
      affected,
      questions,
      note: short.join(' · ') || nothing,
      text: `${lead}: ${parts.join('; ') || nothing}.${open}`,
    };
  };
  for (const node of nodes) {
    if (lostBy(nodes, node.id).length === 0) continue;
    const outage = outageOf(analysis, nodes, edges, { id: node.id }, flows);
    if (!outage) continue;
    // A Boundary is several shapes lost together: a zone, a cluster, a provider.
    if (node.type === 'group') {
      const entry = entryOf(outage, 'boundary', `everything in ${name(node.id)}`, `Without everything in ${name(node.id)}`);
      if (entry) review.entries.push(entry);
      continue;
    }
    const label = name(node.id);
    if (outage.instances) {
      review.covered.push({ id: node.id, name: label, instances: outage.instances.of });
      continue;
    }
    const entry = entryOf(outage, 'shape', label, `Without ${label}`);
    if (entry) review.entries.push(entry);
    else review.spared.push({ id: node.id, name: label });
  }
  for (const edge of edges) {
    const outage = outageOf(analysis, nodes, edges, { id: edge.id, connector: true }, flows);
    if (!outage?.connector) continue;
    const from = listOf(outage.connector.from.map(name));
    const to = listOf(outage.connector.to.map(name));
    const entry = entryOf(outage, 'connector', `${from} → ${to}`, `If ${from} can't reach ${to}`);
    if (entry) review.connectors.push(entry);
  }
  // Stable, so what reads alike stays in the order it was drawn.
  const order = (a: OutageReviewEntry, b: OutageReviewEntry) => Number(b.reaches.length > 0) - Number(a.reaches.length > 0) || b.flows.length - a.flows.length || b.affected - a.affected;
  review.entries.sort(order);
  review.connectors.sort(order);
  return review;
}
