import { connectorStrokePath } from '../src/render/connectorStyle';
import { PERSONALITY_PROFILES } from '../src/render/roughness/presets';
import { bridgePath } from '../src/edges/bridge';
import { describe, expect, it } from 'vitest';
import { normalizeDocument } from '../src/document/validate';
import { serializeDocument } from '../src/export/project';
import { connectorStyleDocument } from './fixtures/connectors/checkout';
import { describeEdge } from '../src/edges/describe';
import { StaticTextMeasurer } from '../src/render/text/measure';
import { THEMES } from '../src/render/theme/tokens';
import { sanitizeChanges } from '../src/collab/sanitize';
import { PERSONALITY_PRESETS } from '../src/ui/personality/usePersonality';

const retired = ['sculpted', 'ribbon', 'technical', 'pencil'];

describe('device-wide connector drawing style', () => {
  it.each(retired)('opens preview files while discarding retired %s overrides in every room', appearance => {
    const document = connectorStyleDocument();
    const original = { ...document.edges[0]!, sourceAnchor: { side: 'right' as const, offset: 0.3 }, waypoints: [{ x: 180, y: 180 }] };
    const edge = { ...original, appearance };
    document.edges[0] = edge;
    document.nodes[0]!.inside = { nodes: document.nodes.slice(1), edges: [{ ...edge, id: 'inner', source: document.nodes[1]!.id, target: document.nodes[2]!.id }], flows: [], viewport: { x: 0, y: 0, zoom: 1 } };
    const parsed = normalizeDocument({ ...JSON.parse(serializeDocument(document)), version: 23 });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.edges[0]).toEqual(original);
    expect(parsed.document.nodes[0]!.inside!.edges[0]).not.toHaveProperty('appearance');
    const changes = sanitizeChanges([{ kind: 'edge', id: edge.id, room: '', value: edge }]);
    expect(changes).toEqual({ ok: true, changes: [{ kind: 'edge', id: edge.id, room: '', value: original }] });
  });

  it.each(PERSONALITY_PRESETS)('%s follows the device setting even with a retired field in a live preview', preset => {
    const document = connectorStyleDocument();
    const edge = document.edges.find(e => e.id === 'authorize')!;
    const nodes = new Map(document.nodes.map(n => [n.id, n]));
    const ctx = { theme: THEMES.light, measurer: new StaticTextMeasurer(), showSequence: false, preset };
    const expected = describeEdge(edge, nodes, ctx);
    for (const appearance of retired) {
      const previewEdge = { ...edge, appearance };
      expect(describeEdge(previewEdge, nodes, ctx)).toEqual(expected);
    }
  });
});


it('keeps Sketch crossing spans continuous so pencil subdivisions cannot erase line jumps', () => {
  const d = 'M0 0 L480 0';
  const drawn = connectorStrokePath(d, 'across:0', PERSONALITY_PROFILES.sketch, true, true);
  for (const x of [120, 240, 360]) {
    const crossed = bridgePath(drawn, [{ x, y: 0, nx: 0, ny: -1, otherSource: 'up', otherTarget: 'down' }]);
    expect(crossed).not.toBe(drawn);
    expect(crossed.match(/C/g)).toHaveLength(2);
  }
});
