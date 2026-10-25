import { describe, expect, it } from 'vitest';
import { analyzeTraffic } from '../../src/traffic';
import { edge, insight, node } from './helpers';

describe('traffic cycles', () => {
  it('marks a two-node loop and gives it no repeated paths', () => {
    const a = node('a', 'service', { text: 'A' });
    const b = node('b', 'service', { text: 'B' });
    const result = analyzeTraffic({ nodes: [a, b], edges: [edge('a-b', a.id, b.id, { semantic: 'calls' }), edge('b-a', b.id, a.id, { semantic: 'calls' })] });
    expect(result.status).toBe('no-entry');
    expect(result.nodes.get(a.id)?.inLoop).toBe(true);
    expect(result.nodes.get(b.id)?.inLoop).toBe(true);
    expect(result.interactions.filter((value) => value.loop)).toHaveLength(2);
    expect(result.interactions.every((value) => value.paths.definite === 0 && value.paths.possible === 0)).toBe(true);
    expect(insight(result, 'loop').text).toMatch(/counted once/i);
  });

  it('treats a self-loop as a loop and not an entry', () => {
    const a = node('a', 'service');
    const result = analyzeTraffic({ nodes: [a], edges: [edge('self', a.id, a.id, { semantic: 'calls' })] });
    expect(result.status).toBe('no-entry');
    expect(result.nodes.get(a.id)).toMatchObject({ inLoop: true, paths: { definite: 0, possible: 0 } });
    expect(result.interactions[0]).toMatchObject({ loop: true, paths: { definite: 0, possible: 0 } });
  });

  it('handles a large directed ring iteratively', () => {
    const nodes = Array.from({ length: 250 }, (_, index) => node(`ring-${index}`, 'service'));
    const edges = nodes.map((value, index) => edge(`ring-edge-${index}`, value.id, nodes[(index + 1) % nodes.length]!.id, { semantic: 'calls' }));
    const result = analyzeTraffic({ nodes, edges });
    expect(result.status).toBe('no-entry');
    expect(result.nodes.size).toBe(nodes.length);
    expect([...result.nodes.values()].every((value) => value.inLoop)).toBe(true);
  });

  it('counts an entry feeding a loop once and propagates finite paths', () => {
    const entry = node('entry', 'service', { text: 'Entry' });
    const a = node('a', 'service', { text: 'A' });
    const b = node('b', 'service', { text: 'B' });
    const after = node('after', 'service', { text: 'After' });
    const result = analyzeTraffic({ nodes: [entry, a, b, after], edges: [
      edge('entry-a', entry.id, a.id, { semantic: 'calls' }),
      edge('a-b', a.id, b.id, { semantic: 'calls' }),
      edge('b-a', b.id, a.id, { semantic: 'calls' }),
      edge('b-after', b.id, after.id, { semantic: 'calls' }),
    ] });
    expect(result.status).toBe('ok');
    expect(result.entries).toEqual([entry.id]);
    expect(result.nodes.get(a.id)?.paths).toEqual({ definite: 1, possible: 1 });
    expect(result.nodes.get(b.id)?.paths).toEqual({ definite: 0, possible: 1 });
    expect(result.nodes.get(after.id)?.paths).toEqual({ definite: 0, possible: 1 });
    expect(result.interactions.filter((value) => value.loop).every((value) => value.paths.definite === 0)).toBe(true);
  });

  it('reports no-entry for a pure loop without an origin', () => {
    const a = node('a', 'service');
    const b = node('b', 'service');
    const c = node('c', 'service');
    const result = analyzeTraffic({ nodes: [a, b, c], edges: [edge('a-b', a.id, b.id, { semantic: 'calls' }), edge('b-c', b.id, c.id, { semantic: 'calls' }), edge('c-a', c.id, a.id, { semantic: 'calls' })] });
    expect(result.status).toBe('no-entry');
    expect(result.entries).toEqual([]);
    expect(result.insights.filter((value) => value.kind === 'loop')).toHaveLength(1);
  });
});
