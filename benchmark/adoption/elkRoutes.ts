/** Adapt ELK's own bends into ordinary connector geometry for the comparison gate. */
import type { ElkNode, ElkPoint } from 'elkjs';
import type { DraftEdge, DraftNode, EdgeAnchor, Side } from '../../src/document/types';
import { anchorPoint, rectOf } from '../../src/edges/routing';

interface Route {
  start: ElkPoint;
  end: ElkPoint;
  bends: ElkPoint[];
}

/** Sections are relative to their containing graph. Multi-section compound edges stay on the
 * baseline adapter until their junction tree can be represented as one connector. */
export function withElkRoutes(graph: ElkNode, nodes: readonly DraftNode[], edges: readonly DraftEdge[]): { edges: DraftEdge[]; adapted: number } {
  const routes = new Map<string, Route>();
  const walk = (node: ElkNode, x = 0, y = 0) => {
    x += node.x ?? 0;
    y += node.y ?? 0;
    const translate = (p: ElkPoint) => ({ x: p.x + x, y: p.y + y });
    for (const edge of node.edges ?? []) {
      if (edge.sections?.length !== 1) continue;
      const section = edge.sections[0]!;
      routes.set(edge.id, { start: translate(section.startPoint), end: translate(section.endPoint), bends: (section.bendPoints ?? []).map(translate) });
    }
    node.children?.forEach((child) => walk(child, x, y));
  };
  walk(graph);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let adapted = 0;
  const placed = edges.map((edge) => {
    const route = routes.get(edge.id);
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!route || !source || !target || edge.routing !== 'smoothstep') return edge;
    const sourceAnchor = pinAt(source, route.start);
    const targetAnchor = pinAt(target, route.end);
    if (!sourceAnchor || !targetAnchor) return edge;
    adapted += 1;
    return {
      ...edge,
      sourceAnchor,
      targetAnchor,
      routeMode: 'direct' as const,
      waypoints: route.bends.length ? route.bends : [{ x: (route.start.x + route.end.x) / 2, y: (route.start.y + route.end.y) / 2 }],
    };
  });
  return { edges: placed, adapted };
}

/** Only adopt a port if it lies on the artwork's actual attachment band, including queue glyphs. */
function pinAt(node: DraftNode, point: ElkPoint): EdgeAnchor | undefined {
  const rect = rectOf(node);
  for (const side of ['top', 'right', 'bottom', 'left'] as Side[]) {
    const a = anchorPoint(rect, side, 0);
    const b = anchorPoint(rect, side, 1);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = dx * dx + dy * dy;
    if (length === 0) continue;
    const offset = ((point.x - a.x) * dx + (point.y - a.y) * dy) / length;
    if (offset < 0 || offset > 1) continue;
    if (Math.hypot(point.x - a.x - offset * dx, point.y - a.y - offset * dy) <= 1) return { side, offset };
  }
  return undefined;
}
