import { describe, expect, it } from 'vitest';
import { analyzeTraffic } from '../../src/traffic';
import { edge, insight, interaction, node } from './helpers';

describe('Junction routes', () => {
  it('flattens A -> J -> B into one definite interaction', () => {
    const a = node('a', 'service', { text: 'A' });
    const j = node('j', 'ellipse');
    const b = node('b', 'service', { text: 'B' });
    const result = analyzeTraffic({ nodes: [a, j, b], edges: [edge('a-j', a.id, j.id, { semantic: 'calls' }), edge('j-b', j.id, b.id, { semantic: 'calls' })] });
    expect(result.interactions).toHaveLength(1);
    expect(interaction(result, a.id, b.id)).toMatchObject({ class: 'request', certainty: 'definite', junctionIds: [j.id], paths: { definite: 1, possible: 1 } });
  });

  it('walks A -> J1 -> J2 -> B once and records both Junctions', () => {
    const a = node('a', 'service');
    const j1 = node('j1', 'ellipse');
    const j2 = node('j2', 'ellipse');
    const b = node('b', 'service');
    const result = analyzeTraffic({ nodes: [a, j1, j2, b], edges: [edge('a-j1', a.id, j1.id, { semantic: 'calls' }), edge('j1-j2', j1.id, j2.id, { semantic: 'calls' }), edge('j2-b', j2.id, b.id, { semantic: 'calls' })] });
    expect(result.interactions).toHaveLength(1);
    expect(interaction(result, a.id, b.id).junctionIds).toEqual([j1.id, j2.id]);
    expect(result.nodes.get(b.id)?.paths).toEqual({ definite: 1, possible: 1 });
  });

  it('marks a two-way Junction split possible without inventing a 50/50 share', () => {
    const a = node('a', 'service', { text: 'A' });
    const j = node('j', 'ellipse', { text: 'Gateway' });
    const b = node('b', 'service', { text: 'B' });
    const c = node('c', 'service', { text: 'C' });
    const result = analyzeTraffic({ nodes: [a, j, b, c], edges: [edge('a-j', a.id, j.id, { semantic: 'calls' }), edge('j-b', j.id, b.id, { semantic: 'calls' }), edge('j-c', j.id, c.id, { semantic: 'calls' })] });
    expect(result.interactions.filter((value) => value.from === a.id)).toHaveLength(2);
    expect(result.interactions.filter((value) => value.from === a.id).every((value) => value.certainty === 'possible' && value.paths.definite === 0 && value.paths.possible === 1)).toBe(true);
    expect(result.edges.get('a-j')?.participation).toBe('flow');
    expect(result.edges.get('j-b')?.participation).toBe('uncertain');
    expect(result.edges.get('j-c')?.participation).toBe('uncertain');
    expect(result.insights.some((value) => value.kind === 'ambiguous-split')).toBe(true);
    expect(result.insights.map((value) => value.text).join(' ')).not.toMatch(/50\s*\/\s*50/);
    expect(result.nodes.get(j.id)).toMatchObject({ role: 'junction', tier: 'none' });
    expect(result.entries).not.toContain(j.id);
    expect(result.hotspots).not.toContain(j.id);
  });

  it('keeps a Junction fan-in as separate source interactions and sums the destination paths', () => {
    const a = node('a', 'service', { text: 'A' });
    const b = node('b', 'service', { text: 'B' });
    const j = node('j', 'ellipse');
    const c = node('c', 'service', { text: 'C' });
    const result = analyzeTraffic({ nodes: [a, b, j, c], edges: [edge('a-j', a.id, j.id, { semantic: 'calls' }), edge('b-j', b.id, j.id, { semantic: 'calls' }), edge('j-c', j.id, c.id, { semantic: 'calls' })] });
    expect(result.interactions.filter((value) => value.to === c.id)).toHaveLength(2);
    expect(result.nodes.get(c.id)?.paths).toEqual({ definite: 2, possible: 2 });
    expect(result.nodes.get(c.id)?.sources).toEqual([a.id, b.id]);
    expect(result.edges.get('j-c')?.paths.definite).toBe(2);
  });

  it('preserves uncertainty through chained fan-in and fan-out Junctions', () => {
    const a = node('a', 'service');
    const b = node('b', 'service');
    const j1 = node('j1', 'ellipse');
    const j2 = node('j2', 'ellipse');
    const c = node('c', 'service');
    const d = node('d', 'service');
    const result = analyzeTraffic({ nodes: [a, b, j1, j2, c, d], edges: [
      edge('a-j1', a.id, j1.id, { semantic: 'calls' }),
      edge('b-j1', b.id, j1.id, { semantic: 'calls' }),
      edge('j1-j2', j1.id, j2.id, { semantic: 'calls' }),
      edge('j2-c', j2.id, c.id, { semantic: 'calls' }),
      edge('j2-d', j2.id, d.id, { semantic: 'calls' }),
    ] });
    expect(result.interactions.filter((value) => value.to === c.id || value.to === d.id)).toHaveLength(4);
    expect(result.nodes.get(c.id)?.paths).toEqual({ definite: 0, possible: 2 });
    expect(result.nodes.get(d.id)?.paths).toEqual({ definite: 0, possible: 2 });
  });

  it('reports an unconnected Junction with outgoing runtime edges', () => {
    const j = node('j', 'ellipse');
    const b = node('b', 'service');
    const result = analyzeTraffic({ nodes: [j, b], edges: [edge('j-b', j.id, b.id, { semantic: 'calls' })] });
    expect(result.status).toBe('nothing-to-analyze');
    expect(insight(result, 'dangling-junction').text).toMatch(/Nothing leads into/);
  });

  it('reports a source whose Junction has no concrete outgoing path', () => {
    const a = node('a', 'service');
    const j = node('j', 'ellipse');
    const result = analyzeTraffic({ nodes: [a, j], edges: [edge('a-j', a.id, j.id, { semantic: 'calls' })] });
    expect(result.status).toBe('nothing-to-analyze');
    expect(insight(result, 'dangling-junction').text).toMatch(/nothing leads on from it/);
  });

  it('marks semantic disagreement on one Junction route unknown and pathless', () => {
    const a = node('a', 'service', { text: 'A' });
    const j = node('j', 'ellipse');
    const b = node('b', 'service', { text: 'B' });
    const result = analyzeTraffic({ nodes: [a, j, b], edges: [edge('a-j', a.id, j.id, { semantic: 'calls' }), edge('j-b', j.id, b.id, { semantic: 'dependsOn' })] });
    const route = interaction(result, a.id, b.id);
    expect(route.class).toBe('unknown');
    expect(route.paths).toEqual({ definite: 0, possible: 0 });
    expect(result.insights.some((value) => value.kind === 'conflicting-semantics')).toBe(true);
  });

  it('terminates a Junction cycle and still reaches a concrete destination', () => {
    const a = node('a', 'service');
    const j1 = node('j1', 'ellipse');
    const j2 = node('j2', 'ellipse');
    const b = node('b', 'service');
    const result = analyzeTraffic({ nodes: [a, j1, j2, b], edges: [edge('a-j1', a.id, j1.id, { semantic: 'calls' }), edge('j1-j2', j1.id, j2.id, { semantic: 'calls' }), edge('j2-j1', j2.id, j1.id, { semantic: 'calls' }), edge('j2-b', j2.id, b.id, { semantic: 'calls' })] });
    expect(result.truncated).toBe(false);
    expect(result.interactions).toHaveLength(1);
    expect(result.nodes.get(b.id)?.paths).toEqual({ definite: 1, possible: 1 });
  });

  it('merges several Junction routes to one service into one logical interaction', () => {
    const a = node('a', 'service');
    const j1 = node('j1', 'ellipse');
    const j2 = node('j2', 'ellipse');
    const j3 = node('j3', 'ellipse');
    const b = node('b', 'service');
    const result = analyzeTraffic({ nodes: [a, j1, j2, j3, b], edges: [
      edge('a-j1', a.id, j1.id, { semantic: 'calls' }),
      edge('j1-j2', j1.id, j2.id, { semantic: 'calls' }),
      edge('j1-j3', j1.id, j3.id, { semantic: 'calls' }),
      edge('j2-b', j2.id, b.id, { semantic: 'calls' }),
      edge('j3-b', j3.id, b.id, { semantic: 'calls' }),
    ] });
    expect(result.interactions).toHaveLength(1);
    expect(interaction(result, a.id, b.id).edgeIds).toEqual(['a-j1', 'j1-j2', 'j2-b', 'j1-j3', 'j3-b']);
  });

  it('merges parallel direct connectors into one interaction without double-counting paths', () => {
    const a = node('a', 'service');
    const b = node('b', 'service');
    const result = analyzeTraffic({ nodes: [a, b], edges: [edge('first', a.id, b.id, { semantic: 'calls' }), edge('second', a.id, b.id, { semantic: 'calls' })] });
    expect(result.interactions).toHaveLength(1);
    expect(interaction(result, a.id, b.id).edgeIds).toEqual(['first', 'second']);
    expect(result.nodes.get(b.id)?.paths).toEqual({ definite: 1, possible: 1 });
  });

  it('marks a route mixing structural and request segments as conflicting', () => {
    const a = node('a', 'service');
    const j1 = node('j1', 'ellipse');
    const j2 = node('j2', 'ellipse');
    const b = node('b', 'service');
    const result = analyzeTraffic({ nodes: [a, j1, j2, b], edges: [edge('a-j1', a.id, j1.id, { semantic: 'calls' }), edge('j1-j2', j1.id, j2.id, { semantic: 'dependsOn' }), edge('j2-b', j2.id, b.id, { semantic: 'calls' })] });
    expect(interaction(result, a.id, b.id).class).toBe('unknown');
    expect(result.insights.some((value) => value.kind === 'conflicting-semantics')).toBe(true);
  });

  it('does not count structural legs as a split', () => {
    const a = node('a', 'service');
    const j = node('j', 'ellipse');
    const b = node('b', 'service');
    const c = node('c', 'service');
    const result = analyzeTraffic({ nodes: [a, j, b, c], edges: [edge('a-j', a.id, j.id, { semantic: 'calls' }), edge('j-b', j.id, b.id, { semantic: 'calls' }), edge('j-c', j.id, c.id, { semantic: 'dependsOn' })] });
    expect(interaction(result, a.id, b.id)).toMatchObject({ class: 'request', certainty: 'definite', paths: { definite: 1, possible: 1 } });
    expect(result.insights.some((value) => value.kind === 'ambiguous-split')).toBe(false);
  });

  it('uses the semantic-bearing leg for route direction and class', () => {
    const database = node('database', 'database', { databaseKind: 'sql' });
    const j = node('j', 'ellipse');
    const service = node('service', 'service');
    const result = analyzeTraffic({ nodes: [database, j, service], edges: [edge('database-j', database.id, j.id), edge('j-service', j.id, service.id, { semantic: 'reads' })] });
    expect(interaction(result, service.id, database.id)).toMatchObject({ class: 'data', from: service.id, to: database.id, certainty: 'definite' });
  });

  it('requires every Junction segment to be synchronous', () => {
    const a = node('a', 'service');
    const j = node('j', 'ellipse');
    const b = node('b', 'service');
    const result = analyzeTraffic({ nodes: [a, j, b], edges: [edge('a-j', a.id, j.id, { semantic: 'calls' }), edge('j-b', j.id, b.id, { semantic: 'calls', async: true })] });
    expect(interaction(result, a.id, b.id).sync).toBe(false);
  });
});
