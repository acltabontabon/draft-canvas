import { visibleEdges } from '../document/compensation';
import type { DraftEdge } from '../document/types';
import { CONNECTOR_STYLE, connectorHead } from '../render/connectorStyle';
import type { ResolvedConnector } from '../render/style/resolve';
import type { Shape } from '../render/displayList';
import { FONTS, LINE_HEIGHTS } from '../render/text/fonts';
import { layoutText } from '../render/text/layout';
import type { TextMeasurer } from '../render/text/measure';
import type { Theme } from '../render/theme/tokens';
import { RESPONSE_DASH, dashForEdge, markerVariantForEdge } from './kindStyle';
import { PORTAL_RING } from './portal';

/**
 * The legend: the kinds of line this diagram actually draws, each with a sample and its name, so a
 * reader who was never told that dots mean an event can still read the picture. Worked out from the
 * connectors, never authored and never saved: a diagram that stops using a style stops listing it,
 * and one drawn in a single style has nothing to explain and gets no legend at all.
 *
 * Pure, and one description for the canvas and the export (`describeLegend`).
 */

export type LegendKind = 'call' | 'link' | 'async' | 'event' | 'retry' | 'fallback' | 'compensation' | 'callback' | 'implements' | 'reply' | 'portal';

export interface LegendEntry {
  kind: LegendKind;
  label: string;
  dash?: number[];
  /** Whether the sample ends in an arrowhead, and which. */
  head: 'closed' | 'open' | 'none';
}

/** Every kind in the order a legend lists them: the plain ones first, the exceptions after. */
const ORDER: readonly LegendKind[] = ['call', 'link', 'async', 'event', 'reply', 'callback', 'implements', 'retry', 'fallback', 'compensation', 'portal'];

const LABELS: Record<LegendKind, string> = {
  call: 'Call',
  link: 'Association',
  async: 'Asynchronous',
  event: 'Event',
  retry: 'Retry',
  fallback: 'Fallback',
  compensation: 'Compensating action',
  callback: 'Callback',
  implements: 'Implements',
  reply: 'Reply',
  portal: 'Continues elsewhere',
};

/** How one connector's own line is drawn, as a legend names it. */
function kindOf(edge: DraftEdge): LegendKind {
  if (edge.portal) return 'portal';
  if (edge.semantic === 'implements' || edge.semantic === 'implementedBy') return 'implements';
  if (edge.kind === 'callback') return 'callback';
  if (edge.kind === 'event' || edge.kind === 'retry' || edge.kind === 'fallback') return edge.kind;
  // The same test `dashForEdge` makes for a linked compensation, read off its result: [5, 4].
  const dash = dashForEdge(edge);
  if (dash && dash[0] === 5 && edge.semantic === 'compensates') return 'compensation';
  if (edge.async) return 'async';
  return edge.directed ? 'call' : 'link';
}

function sampleOf(kind: LegendKind, edges: readonly DraftEdge[]): Pick<LegendEntry, 'dash' | 'head'> {
  if (kind === 'reply') return { dash: RESPONSE_DASH, head: 'open' };
  const edge = edges.find((candidate) => kindOf(candidate) === kind)!;
  const dash = dashForEdge(edge);
  return { ...(dash ? { dash } : {}), head: !edge.directed ? 'none' : markerVariantForEdge(edge) };
}

/**
 * The line styles in use, in legend order. Empty when the diagram draws fewer than two: one style
 * needs no key.
 */
export function legendEntries(all: readonly DraftEdge[]): LegendEntry[] {
  const edges = visibleEdges(all);
  const used = new Set<LegendKind>();
  for (const edge of edges) {
    used.add(kindOf(edge));
    if (edge.hasResponse && !edge.portal) used.add('reply');
  }
  if (used.size < 2) return [];
  return ORDER.filter((kind) => used.has(kind)).map((kind) => ({ kind, label: LABELS[kind], ...sampleOf(kind, edges) }));
}

export interface Legend {
  shapes: Shape[];
  width: number;
  height: number;
}

const SAMPLE = 34;
const ROW = 14;
const SAMPLE_GAP = 7;
const ENTRY_GAP = 18;

/**
 * The legend as one row at the origin: a quiet title, then each style's sample and name. Arrowheads
 * are drawn as their own paths (the head every connector wears, `connectorHead`), not referenced
 * markers, so the row draws the same wherever it is placed.
 */
export function describeLegend(edges: readonly DraftEdge[], ctx: { theme: Theme; measurer?: TextMeasurer; connector?: ResolvedConnector }): Legend | null {
  const entries = legendEntries(edges);
  if (entries.length === 0) return null;
  const color = ctx.theme.edge;
  const font = FONTS.connectorCaption;
  const lineHeight = font.size * LINE_HEIGHTS.label;
  const title = layoutText('Lines', { font: FONTS.presetTag, maxWidth: 200, lineHeight: FONTS.presetTag.size * LINE_HEIGHTS.label, maxLines: 1, measurer: ctx.measurer });
  const shapes: Shape[] = [{ t: 'text', x: 0, y: ROW / 2 - title.height / 2, layout: title, font: FONTS.presetTag, fill: ctx.theme.textFaint, align: 'start' }];
  let x = title.width + ENTRY_GAP;
  const y = ROW / 2;
  for (const entry of entries) {
    const stroke = { color, width: ctx.connector?.lineWidth ?? CONNECTOR_STYLE.lineWidth, linecap: 'round' as const, ...(entry.dash ? { dash: entry.dash } : {}) };
    if (entry.kind === 'portal') {
      const end = x + SAMPLE - PORTAL_RING * 2;
      shapes.push(
        { t: 'path', d: `M${x} ${y}L${end} ${y}`, fill: 'none', stroke },
        { t: 'ellipse', cx: end + PORTAL_RING, cy: y, rx: PORTAL_RING, ry: PORTAL_RING, stroke: { color, width: CONNECTOR_STYLE.openArrowWidth } },
      );
    } else {
      // The line stops inside the head, as a marker's does, so a dashed line never pokes through it.
      const reach = entry.head === 'none' ? SAMPLE : SAMPLE - CONNECTOR_STYLE.arrowLength * 0.5;
      shapes.push({ t: 'path', d: `M${x} ${y}L${x + reach} ${y}`, fill: 'none', stroke });
      if (entry.head !== 'none') {
        shapes.push({
          t: 'group',
          translate: { x: x + SAMPLE - CONNECTOR_STYLE.arrowLength, y: y - CONNECTOR_STYLE.arrowWidth / 2 },
          children: [
            entry.head === 'open'
              ? { t: 'path', d: connectorHead(true, ctx.connector?.head), fill: 'none', stroke: { color, width: CONNECTOR_STYLE.openArrowWidth, linecap: 'round' } }
              : { t: 'path', d: connectorHead(false, ctx.connector?.head), fill: color },
          ],
        });
      }
    }
    x += SAMPLE + SAMPLE_GAP;
    const label = layoutText(entry.label, { font, maxWidth: 240, lineHeight, maxLines: 1, measurer: ctx.measurer });
    shapes.push({ t: 'text', x, y: ROW / 2 - label.height / 2, layout: label, font, fill: ctx.theme.textMuted, align: 'start' });
    x += label.width + ENTRY_GAP;
  }
  return { shapes, width: x - ENTRY_GAP, height: ROW };
}
