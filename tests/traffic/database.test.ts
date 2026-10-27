import { describe, expect, it } from 'vitest';
import { analyzeTraffic } from '../../src/traffic';
import { databaseWork } from '../../src/traffic/database';
import { edge, node } from './helpers';

const nodes = [node('a', 'service'), node('b', 'service'), node('db', 'database')];
describe('illustrative database work', () => {
  it('separates explicit reads and writes, including reverse read-by connectors', () => {
    const edges = [edge('r', 'db', 'a', { semantic: 'reads' }), edge('w', 'b', 'db', { semantic: 'writes' })];
    const analysis = analyzeTraffic({ nodes, edges });
    expect(databaseWork(analysis, edges, 'db')).toEqual(['~1,000 reads/min', '~1,000 writes/min']);
    expect(databaseWork(analysis, edges, 'a')).toBeNull();
  });
  it('keeps merged and unspecified routes combined without doubling their rate', () => {
    const edges = [edge('r', 'a', 'db', { semantic: 'reads' }), edge('w', 'a', 'db', { semantic: 'writes' })];
    expect(databaseWork(analyzeTraffic({ nodes, edges }), edges, 'db')).toEqual(['~1,000 combined / unspecified ops/min']);
    const combined = [edge('rw', 'a', 'db', { semantic: 'readsWrites' })];
    expect(databaseWork(analyzeTraffic({ nodes, edges: combined }), combined, 'db')).toEqual(['~1,000 combined / unspecified ops/min']);
  });
  it('keeps uncertain shares and excludes retry work and inactive flow connectors', () => {
    const edges = [edge('r', 'a', 'db', { semantic: 'reads', kind: 'conditional' }), edge('w', 'b', 'db', { semantic: 'writes' }), edge('retry', 'a', 'db', { semantic: 'writes', kind: 'retry' })];
    const analysis = analyzeTraffic({ nodes, edges, edgeIds: new Set(['r', 'retry']) });
    expect(databaseWork(analysis, edges, 'db')).toEqual(['0–1,000 reads/min']);
    expect(databaseWork({ ...analysis, truncated: true }, edges, 'db')).toEqual(['Database work unknown — loop repeats or analysis limits.']);
  });
});
