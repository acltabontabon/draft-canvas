import { describe, expect, it } from 'vitest';
import { CONNECTOR_APPEARANCES, type DraftEdge } from '../src/document/types';
import { createEdge } from '../src/document/factory';
import { normalizeDocument } from '../src/document/validate';
import { serializeDocument } from '../src/export/project';
import { connectorStyleDocument } from './fixtures/connectors/checkout';
import { connectorRoutes } from '../src/edges/connectorRoutes';
import { describeEdge } from '../src/edges/describe';
import { StaticTextMeasurer } from '../src/render/text/measure';
import { THEMES } from '../src/render/theme/tokens';
import { connectorDefs, markerRef } from '../src/render/svg/markers';
import { CONNECTOR_TREATMENTS, styledConnectorPath } from '../src/render/connectorStyle';
import { sanitizeChanges } from '../src/collab/sanitize';
import { stepPolyline } from '../src/edges/waypoints';

for (const appearance of CONNECTOR_APPEARANCES) {
  describe(`${appearance} connector appearance`, () => {
    it('survives file and collaboration normalization, including inside views', () => {
      const document = connectorStyleDocument();
      const edge = createEdge({ ...document.edges[0]!, appearance });
      document.edges[0] = edge;
      document.nodes[0]!.inside = { nodes: document.nodes.slice(1), edges: [{ ...edge, id: 'inner', source: document.nodes[1]!.id, target: document.nodes[2]!.id }], flows: [], viewport: { x: 0, y: 0, zoom: 1 } };
      const parsed = normalizeDocument(JSON.parse(serializeDocument(document)));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.document.edges[0]!.appearance).toBe(appearance);
      expect(parsed.document.nodes[0]!.inside!.edges[0]!.appearance).toBe(appearance);
      const changes = sanitizeChanges([{ kind: 'edge', id: edge.id, room: '', value: edge }]);
      expect(changes).toEqual({ ok: true, changes: [{ kind: 'edge', id: edge.id, room: '', value: edge }] });
    });

    it('keeps endpoints, waypoint geometry, semantics and reply direction when restyled', () => {
      const doc = connectorStyleDocument();
      const original = doc.edges.find(e => e.id === 'authorize')!;
      const edge: DraftEdge = { ...original, appearance };
      const routes = connectorRoutes(edge, doc, 'transient')!;
      const d = styledConnectorPath(routes.request.d, edge);
      const points = stepPolyline(d);
      const canonical = stepPolyline(routes.request.d);
      expect(points[0]).toEqual(canonical[0]);
      expect(points.at(-1)).toEqual(canonical.at(-1));
      expect(connectorRoutes(original, doc, 'transient')).toEqual(routes);
      expect(styledConnectorPath(routes.request.d, { ...edge, waypoints: [{ x: 20, y: 10 }] })).toBe(routes.request.d);
      const nodes = new Map(doc.nodes.map(n => [n.id, n]));
      const described = describeEdge(edge, nodes, { routes, theme: THEMES.light, measurer: new StaticTextMeasurer(), showSequence: false })!;
      const line = described.line[0]!;
      expect(line.t === 'path' && line.stroke!.width).toBe(CONNECTOR_TREATMENTS[appearance].lineWidth);
      expect(described.responseLine).toBeDefined();
      const defs = connectorDefs(['#123456']);
      const ref = markerRef('#123456', 'open', appearance);
      expect(defs.some(def => `url(#${def.attrs!.id})` === ref)).toBe(true);
    });
  });
}

it('uses Sculpted Ink for legacy and invalid appearance values without writing a preference', () => {
  for (const appearance of [undefined, 'unknown', { unsafe: true }]) {
    const doc = connectorStyleDocument();
    const result = normalizeDocument({ ...doc, edges: [{ ...doc.edges[0], appearance }] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.document.edges[0]!.appearance).toBeUndefined();
  }
});
