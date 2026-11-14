import { categoryOf } from '../document/connectorSemantics';
import type { DraftEdge, DraftNode } from '../document/types';
import { connectorCaptionText } from '../edges/captionText';
import { connectorRoutes } from '../edges/connectorRoutes';
import { labelGroupPlan } from '../edges/labelGroups';
import { fittedConnectorCaption, layoutEdgeLabel } from '../edges/labelLayout';
import { nameLineCount, type DescribeContext } from '../nodes/describe';
import { arrangedSize } from './place';
import { checkFit, renderedBoundsOf, smallestFontPresent } from './quality';

/**
 * Whether a diagram explains itself, beyond whether its lines are clean.
 *
 * `quality.ts` and `legibility.ts` judge geometry: overlaps, lines through shapes, crossings. A view
 * can pass all of that and still be hard to read, in four ways this measures:
 *
 * - `stacked-name`: a name wrapped into a column of short lines, where a wider box holds it in fewer;
 * - `hidden-caption`: a connector's label or relationship caption cut short or left out, because the
 *   line it sits on is too short for it;
 * - `heavy-header`: a boundary whose header band is most of it, its contents a strip at the bottom;
 * - `sparse`: so much space between shapes that the whole view, fitted to a screen, draws its
 *   smallest text too small to read.
 *
 * Measures, not errors: nothing here refuses or repairs a layout. They exist to be compared across a
 * proposed arrangement (`resolvedBy`), so a person is told only about problems the proposal fixes.
 */
export type ProportionKind = 'stacked-name' | 'hidden-caption' | 'heavy-header' | 'sparse';

export interface ProportionFinding {
  kind: ProportionKind;
  /** The shape, connector or boundary concerned; empty for `sparse`, which is about the whole view. */
  id: string;
  /** `sparse` only: the scale the view is drawn at when fitted to the screen. */
  scale?: number;
}

/** The screen a view is judged against when none is given: a laptop's (`compile.ts`'s `SCREEN`). */
export const OVERVIEW_SCREEN: readonly [number, number] = [1440, 900];

const isNoteLike = (node: DraftNode) => node.type === 'note' || node.type === 'text' || node.type === 'code';

/** A header band this much of its boundary's height, or more, outweighs what the boundary holds. */
const HEAVY_HEADER_SHARE = 0.45;
/** …but only past the room a title and its caption take anyway (`BOUNDARY_HEADER`), with slack. */
const HEAVY_HEADER_MIN = 96;
/** An arrangement has to draw the view this much larger for `sparse` to count as fixed. */
const CLEARLY_LARGER = 1.1;

export function proportionFindings(
  view: { nodes: readonly DraftNode[]; edges: readonly DraftEdge[] },
  ctx: DescribeContext,
  screen: readonly [number, number] = OVERVIEW_SCREEN,
): ProportionFinding[] {
  const findings: ProportionFinding[] = [];
  const byId = new Map(view.nodes.map((node) => [node.id, node]));

  for (const node of view.nodes) {
    if (node.type === 'group' || isNoteLike(node) || !node.text?.trim()) continue;
    // `arrangedSize`'s own trigger, so the check and Arrange's fix agree: more than two lines, and a
    // balanced box that takes fewer.
    const lines = nameLineCount(node, ctx);
    if (lines <= 2) continue;
    const sized = arrangedSize(node, ctx);
    if (nameLineCount({ ...node, ...sized }, ctx) < lines) findings.push({ kind: 'stacked-name', id: node.id });
  }

  const groups = labelGroupPlan(view.nodes, view.edges, 'transient');
  for (const edge of view.edges) {
    // A fan's members share one caption on the trunk and hide their own on purpose.
    if (groups.groupFor(edge.id)) continue;
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) continue;
    const route = connectorRoutes(edge, view, 'transient', byId)?.request;
    // No room at all is a bundled member, whose caption is drawn once on the shared trunk.
    if (!route || route.labelRoom === 0) continue;
    const label = edge.label?.trim();
    if (label) {
      if (layoutEdgeLabel(label, ctx.measurer, route.labelRoom).truncated) findings.push({ kind: 'hidden-caption', id: edge.id });
      continue;
    }
    const caption = connectorCaptionText(edge, categoryOf(source), categoryOf(target));
    if (!caption) continue;
    const fitted = fittedConnectorCaption(caption.text, ctx.measurer, route.labelRoom);
    if (!fitted || fitted.truncated) findings.push({ kind: 'hidden-caption', id: edge.id });
  }

  for (const group of view.nodes) {
    if (group.type !== 'group') continue;
    const members = view.nodes.filter((node) => node.parentId === group.id);
    if (!members.length) continue;
    const band = Math.min(...members.map((node) => node.y)) - group.y;
    if (band >= HEAVY_HEADER_MIN && band >= group.height * HEAVY_HEADER_SHARE) findings.push({ kind: 'heavy-header', id: group.id });
  }

  if (view.nodes.length > 1) {
    const fit = checkFit(renderedBoundsOf(view.nodes, view.edges, ctx), smallestFontPresent(view.nodes, view.edges), screen);
    if (!fit.readable) findings.push({ kind: 'sparse', id: '', scale: fit.scale });
  }
  return findings;
}

/**
 * The findings of `before` that `after` no longer has: what a proposed arrangement actually fixes.
 * A small overview counts as fixed when the view becomes readable, or is drawn clearly larger.
 */
export function resolvedBy(before: readonly ProportionFinding[], after: readonly ProportionFinding[]): ProportionFinding[] {
  const still = new Set(after.map((finding) => `${finding.kind}:${finding.id}`));
  const sparseAfter = after.find((finding) => finding.kind === 'sparse');
  return before.filter((finding) => {
    if (finding.kind !== 'sparse') return !still.has(`${finding.kind}:${finding.id}`);
    return !sparseAfter || (sparseAfter.scale ?? 0) >= (finding.scale ?? 0) * CLEARLY_LARGER;
  });
}

/** What a receipt says of these findings, by id, beside the legibility counts; nothing when clean. */
export function proportionReceipt(findings: readonly ProportionFinding[]) {
  const ids = (kind: ProportionKind) => findings.filter((finding) => finding.kind === kind).map((finding) => finding.id).slice(0, 10);
  const stacked = ids('stacked-name');
  const hidden = ids('hidden-caption');
  const heavy = ids('heavy-header');
  const sparse = findings.find((finding) => finding.kind === 'sparse');
  return {
    ...(stacked.length ? { stackedNames: stacked } : {}),
    ...(hidden.length ? { hiddenCaptions: hidden } : {}),
    ...(heavy.length ? { heavyHeaders: heavy } : {}),
    ...(sparse ? { smallOverview: { scale: Math.round((sparse.scale ?? 0) * 100) / 100, screen: [...OVERVIEW_SCREEN] } } : {}),
  };
}

const quoted = (ids: readonly string[]) => ids.map((id) => `"${id}"`).join(', ');

/**
 * What to change for each finding, with the op that does it — for a receipt's advisories. `mine`
 * narrows it to what an edit touched (an edit is not told to fix what it never went near); `sparse`
 * is left out by a caller that knows the view was already that small before the edit.
 */
export function proportionAdvice(findings: readonly ProportionFinding[], mine: (id: string) => boolean = () => true, sparse = true): string[] {
  const of = (kind: ProportionKind) => findings.filter((finding) => finding.kind === kind && mine(finding.id)).map((finding) => finding.id).slice(0, 3);
  const out: string[] = [];
  const stacked = of('stacked-name');
  if (stacked.length) out.push(`${quoted(stacked)} ${stacked.length > 1 ? 'wrap their names' : 'wraps its name'} into a tall column: ${JSON.stringify({ op: 'arrange' })} gives a long name a wider box, or shorten the name.`);
  const hidden = of('hidden-caption');
  if (hidden.length) out.push(`The words on ${quoted(hidden)} have no room on ${hidden.length > 1 ? 'their lines and are' : 'its line and is'} cut short or left out: ${JSON.stringify({ op: 'arrange' })} makes the gap as long as the caption needs, or shorten the label.`);
  const heavy = of('heavy-header');
  if (heavy.length) out.push(`${heavy.length > 1 ? 'Boundaries' : 'Boundary'} ${quoted(heavy)} ${heavy.length > 1 ? 'are' : 'is'} mostly header, with ${heavy.length > 1 ? 'their' : 'its'} contents a strip at the bottom: ${JSON.stringify({ op: 'arrange', scope: { group: heavy[0] } })} fits it to what it holds.`);
  const small = sparse ? findings.find((finding) => finding.kind === 'sparse') : undefined;
  if (small) out.push(`Fitted to a ${OVERVIEW_SCREEN[0]}×${OVERVIEW_SCREEN[1]} screen this view is drawn at ${Math.round((small.scale ?? 0) * 100)}%, its smallest text too small to read: ${JSON.stringify({ op: 'arrange', spacing: 'compact' })} sets it tighter, or move detail into an element's inside view.`);
  return out;
}
