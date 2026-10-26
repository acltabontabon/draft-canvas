/**
 * Every connector of a view as the canvas draws it: request line, reply line, caption chip, and the
 * trunk and label group it shares on purpose. The one place the quality harness asks for geometry.
 */

import type { DraftEdge, DraftNode } from '../../../src/document/types';
import { routingPlan } from '../../../src/edges/bundles';
import { connectorRouteInputs } from '../../../src/edges/connectorRoutes';
import { edgeRoutes } from '../../../src/edges/edgeRoutes';
import { LABEL_PADDING_X, LABEL_PADDING_Y, layoutEdgeLabel } from '../../../src/edges/labelLayout';
import { labelChipBox, labelGroupPlan } from '../../../src/edges/labelGroups';
import { labelChipSide, labelLaneOffset, laneIndex, responseAwayAt, type Rect, type Side } from '../../../src/edges/routing';

export interface DrawnLine {
  d: string;
  source: { x: number; y: number; side: Side };
  target: { x: number; y: number; side: Side };
  status?: 'clear' | 'blocked' | 'budget' | 'unchecked';
}

export interface DrawnConnector {
  edge: DraftEdge;
  request: DrawnLine;
  response: DrawnLine | null;
  /** The caption chip this connector draws, if any (a label group's first member draws the group's). */
  chip: Rect | null;
  spine?: string;
  labelGroup?: string;
}

/** `spread: false` draws every automatic end where it would sit with no endpoint plan — the picture
 *  before ends were spread, for measuring what spreading changes. */
export function drawnConnectors(nodes: readonly DraftNode[], edges: readonly DraftEdge[], options: { spread?: boolean } = {}): DrawnConnector[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const lanes = laneIndex(edges);
  const plan = routingPlan(nodes, edges, 'transient');
  const groups = labelGroupPlan(nodes, edges, 'transient');
  const out: DrawnConnector[] = [];
  for (const edge of edges) {
    const lane = lanes.get(edge.id)?.offset ?? 0;
    const spine = plan.spineFor(edge.id);
    const inputs = connectorRouteInputs(edge, { nodes, edges }, 'transient', byId);
    if (!inputs) continue;
    if (options.spread === false) delete inputs.spread;
    const routes = edgeRoutes(inputs, 'transient');
    const request = routes.request;
    const group = groups.groupFor(edge.id);
    let chip: Rect | null = null;
    if (edge.label?.trim()) {
      const layout = layoutEdgeLabel(edge.label);
      const [w, h] = [layout.width + LABEL_PADDING_X * 2, layout.height + LABEL_PADDING_Y * 2];
      if (group) {
        if (group.members[0] === edge.id) chip = labelChipBox(group.side, group.x, group.y, w, h);
      } else {
        const nudge = labelLaneOffset(request.source.side, request.target.side, lane);
        chip = labelChipBox(labelChipSide(request.labelSide, responseAwayAt(request, routes.response, lane)), request.labelX + nudge.x, request.labelY + nudge.y, w, h);
      }
    }
    out.push({
      edge,
      request,
      response: routes.response,
      chip,
      ...(spine ? { spine: spine.id } : {}),
      ...(group ? { labelGroup: group.key } : {}),
    });
  }
  return out;
}
