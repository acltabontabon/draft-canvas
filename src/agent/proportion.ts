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
