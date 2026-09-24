/**
 * Is an arranged diagram readable? Checked before anything is committed, on the geometry that would be
 * saved, with the renderer's own text measurement and the canvas's own connector routing.
 *
 * Two classes, kept apart on purpose:
 *
 * - **errors** — shapes on top of each other, a shape spilling out of its boundary (or into one it
 *   doesn't belong to), text that would be clipped, a connector drawn through a shape it has nothing
 *   to do with, a caption drawn over a shape, geometry that isn't finite. A new diagram with one of
 *   these is repaired (wider spacing) or refused; nobody should receive it.
 * - **warnings** — things a person might tidy but can read past: two captions touching.
 *
 * For an update only what the request added or changed is judged, together with what it now touches,
 * so a person's own arrangement elsewhere can never fail an agent's request.
 */

import type { DraftEdge, DraftNode } from '../document/types';
import { naturalArchitectureSize, type DescribeContext } from '../nodes/describe';
import { isC4Element } from '../depth/c4';
import { captionSizer } from './place';
import { routingPlan } from '../edges/bundles';
import { crosses, othersOf, overlaps, routeProblem, stacked, together, type Box, type Other } from './route';

export interface QualityIssue {
  kind: 'overlap' | 'outside-group' | 'clipped-text' | 'through-node' | 'label-over-node' | 'label-collision' | 'label-crossed' | 'shared-run' | 'invalid-geometry' | 'jog';
  ids: string[];
  message: string;
}

export interface QualityReport {
  errors: QualityIssue[];
  warnings: QualityIssue[];
}

/** How bad each kind of problem is when choosing between candidates: hidden content first. */
const WEIGHT: Record<QualityIssue['kind'], number> = {
  'invalid-geometry': 1000,
  overlap: 100,
  'outside-group': 100,
  'clipped-text': 60,
  'through-node': 50,
  'label-over-node': 30,
  'label-collision': 20,
  'label-crossed': 20,
  'shared-run': 25,
  jog: 1,
};

/**
 * One number to compare candidate arrangements by: errors by how much they hide, then (far less)
 * skewed connectors. Lower is better; 0 is a clean result with every connector straight.
 */
export function scoreOf(report: QualityReport): number {
  return [...report.errors, ...report.warnings].reduce((sum, issue) => sum + WEIGHT[issue.kind], 0);
}

const contains = (outer: Box, inner: Box) =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

export function checkQuality(
  nodes: readonly DraftNode[],
  edges: readonly DraftEdge[],
  ctx: DescribeContext,
  focus?: ReadonlySet<string>,
): QualityReport {
  const errors: QualityIssue[] = [];
  const warnings: QualityIssue[] = [];
  const judged = (...ids: string[]) => !focus || ids.some((id) => focus.has(id));
  const byId = new Map(nodes.map((n) => [n.id, n]));

  for (const node of nodes) {
    if (![node.x, node.y, node.width, node.height].every(Number.isFinite) || node.width <= 0 || node.height <= 0) {
      errors.push({ kind: 'invalid-geometry', ids: [node.id], message: `${node.id} has no usable position or size.` });
    }
  }

  // Overlap between shapes that aren't boundaries (a boundary overlapping its contents is the point).
  const solid = nodes.filter((n) => n.type !== 'group');
  for (let i = 0; i < solid.length; i += 1) {
    for (let j = i + 1; j < solid.length; j += 1) {
      const a = solid[i] as DraftNode;
      const b = solid[j] as DraftNode;
      if (!judged(a.id, b.id)) continue;
      if (overlaps(a, b)) errors.push({ kind: 'overlap', ids: [a.id, b.id], message: `${a.id} and ${b.id} overlap.` });
    }
  }
  // A boundary holds its own members and no one else's.
  const groups = nodes.filter((n) => n.type === 'group');
  const ancestors = (node: DraftNode): Set<string> => {
    const out = new Set<string>();
    let at = node.parentId;
    while (at && !out.has(at)) {
      out.add(at);
      at = byId.get(at)?.parentId;
    }
    return out;
  };
  for (const node of nodes) {
    const mine = ancestors(node);
    for (const group of groups) {
      if (group.id === node.id || !judged(node.id, group.id)) continue;
      const inside = mine.has(group.id);
      if (inside && !contains(group, node)) {
        errors.push({ kind: 'outside-group', ids: [node.id, group.id], message: `${node.id} spills out of its boundary ${group.id}.` });
      } else if (!inside && overlaps(group, node) && !(node.type === 'group' && ancestors(group).has(node.id))) {
        errors.push({ kind: 'overlap', ids: [node.id, group.id], message: `${node.id} overlaps boundary ${group.id} without being inside it.` });
      }
    }
  }

  // Clipped text: the renderer is asked, at the size the shape actually has.
  for (const node of nodes) {
    if (!isC4Element(node) || !judged(node.id)) continue;
    const natural = naturalArchitectureSize(node, ctx, { maxWidth: node.width, maxHeight: node.height });
    if (!natural.fits) errors.push({ kind: 'clipped-text', ids: [node.id], message: `${node.id}'s text doesn't fit its shape.` });
  }

  // Connectors and their captions, exactly as the canvas draws them.
  const caption = captionSizer(nodes, ctx);
  for (const edge of edges) {
    const problem = judged(edge.id, edge.source, edge.target) ? routeProblem(edge, nodes, edges, caption) : undefined;
    if (problem?.kind === 'through-node') errors.push({ kind: 'through-node', ids: [edge.id, problem.node], message: `connector ${edge.id} runs through ${problem.node}.` });
    if (problem?.kind === 'label-over-node') errors.push({ kind: 'label-over-node', ids: [edge.id, problem.node], message: `the caption of ${edge.id} covers ${problem.node}.` });
  }
  const drawn = othersOf(nodes, edges, caption);
  // A connector between two facing sides that still steps sideways on its way reads as skewed. Only
  // one of several connectors leaving (or reaching) the same side can be straight — the rest of a
  // fan must step — so only a connector alone on both its sides counts.
  const plan = routingPlan(nodes, edges);
  const onSide = new Map<string, number>();
  const sideKey = (node: string, side?: string) => `${node}|${side ?? ''}`;
  for (const edge of edges) {
    for (const key of [sideKey(edge.source, edge.sourceAnchor?.side), sideKey(edge.target, edge.targetAnchor?.side)]) onSide.set(key, (onSide.get(key) ?? 0) + 1);
  }
  const facing = (a?: string, b?: string) =>
    (a === 'right' && b === 'left') || (a === 'left' && b === 'right') || (a === 'bottom' && b === 'top') || (a === 'top' && b === 'bottom');
  for (const edge of edges) {
    if (!judged(edge.id, edge.source, edge.target) || plan.spineFor(edge.id)) continue;
    if (!facing(edge.sourceAnchor?.side, edge.targetAnchor?.side)) continue;
    if (onSide.get(sideKey(edge.source, edge.sourceAnchor?.side)) !== 1 || onSide.get(sideKey(edge.target, edge.targetAnchor?.side)) !== 1) continue;
    const route = drawn.find((o) => o.id === edge.id);
    const start = route?.points[0];
    const end = route?.points[route.points.length - 1];
    if (!start || !end) continue;
    const across = edge.sourceAnchor?.side === 'left' || edge.sourceAnchor?.side === 'right' ? Math.abs(start.y - end.y) : Math.abs(start.x - end.x);
    if (across > 1) warnings.push({ kind: 'jog', ids: [edge.id], message: `connector ${edge.id} steps sideways between ${edge.source} and ${edge.target}.` });
  }
  for (let i = 0; i < drawn.length; i += 1) {
    for (let j = i + 1; j < drawn.length; j += 1) {
      const a = drawn[i] as Other;
      const b = drawn[j] as Other;
      if (!judged(a.id, b.id)) continue;
      if (together(a, b)) continue;
      if (stacked(a, b)) {
        errors.push({ kind: 'shared-run', ids: [a.id, b.id], message: `connectors ${a.id} and ${b.id} run on top of each other.` });
        continue;
      }
      // Two captions on top of each other read as neither, and a line through a caption strikes its
      // words out: errors, like a caption over a shape.
      if (a.chip && b.chip && overlaps(a.chip, b.chip)) {
        errors.push({ kind: 'label-collision', ids: [a.id, b.id], message: `the captions of ${a.id} and ${b.id} overlap.` });
      } else if (crosses(a, b)) {
        errors.push({ kind: 'label-crossed', ids: [a.id, b.id], message: `connectors ${a.id} and ${b.id} run through each other's caption.` });
      }
    }
  }
  return { errors, warnings };
}
