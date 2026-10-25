import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { analyzeTraffic } from '../../src/traffic';
import { edge, node } from './helpers';

describe('traffic module boundary', () => {
  it('imports only sibling traffic modules and document modules', () => {
    const trafficDirectory = join(process.cwd(), 'src/traffic');
    const files = ['analyze.ts', 'classify.ts', 'eligibility.ts', 'graph.ts', 'index.ts', 'insights.ts', 'types.ts'];
    const imports = /(?:from|import\()\s*['"]([^'"]+)['"]/g;
    for (const file of files) {
      const source = readFileSync(join(trafficDirectory, file), 'utf8');
      for (const match of source.matchAll(imports)) {
        const path = match[1]!;
        expect(path.startsWith('./') || path.startsWith('../document/'), `${file} imports ${path}`).toBe(true);
      }
    }
  });
});

describe('malformed traffic input', () => {
  it('ignores missing endpoints and keeps the first duplicate node and edge ids', () => {
    const first = node('duplicate', 'service', { text: 'First' });
    const second = node('duplicate', 'service', { text: 'Second' });
    const target = node('target', 'service');
    const firstEdge = edge('duplicate-edge', first.id, target.id, { semantic: 'calls' });
    const secondEdge = edge('duplicate-edge', target.id, first.id, { semantic: 'calls' });
    const result = analyzeTraffic({ nodes: [first, second, target], edges: [firstEdge, secondEdge, edge('missing', 'absent', target.id, { semantic: 'calls' })] });
    expect(result.nodes.get(first.id)).toMatchObject({ id: first.id });
    expect(result.interactions).toHaveLength(1);
    expect(result.interactions[0]).toMatchObject({ from: first.id, to: target.id });
  });

  it('keeps a tiny Junction budget bounded and reports truncation without throwing', () => {
    const service = node('service', 'service');
    const junction = node('junction', 'ellipse');
    const target = node('target', 'service');
    expect(() => analyzeTraffic({ nodes: [service, junction, target], edges: [edge('in', service.id, junction.id, { semantic: 'calls' }), edge('out', junction.id, target.id, { semantic: 'calls' })] }, { maxJunctionSteps: 1, maxInteractions: 100 })).not.toThrow();
    const result = analyzeTraffic({ nodes: [service, junction, target], edges: [edge('in', service.id, junction.id, { semantic: 'calls' }), edge('out', junction.id, target.id, { semantic: 'calls' })] }, { maxJunctionSteps: 1, maxInteractions: 100 });
    expect(result.truncated).toBe(true);
  });
});
