import { describe, expect, it } from 'vitest';
import { createEdge, createNode } from '../../src/document/factory';
import type { DraftEdge, DraftNode } from '../../src/document/types';
import { PATH_CAP } from '../../src/traffic';
import { analyzeTraffic, mayHaveTraffic } from '../../src/traffic';

function service(id: string): DraftNode {
  return createNode({ type: 'service', id, x: 0, y: 0, text: id });
}

function junction(id: string): DraftNode {
  return createNode({ type: 'ellipse', id, x: 0, y: 0 });
}

function edge(id: string, source: string, target: string, semantic: DraftEdge['semantic'] = 'calls'): DraftEdge {
  return createEdge({ id, source, target, semantic });
}

describe('traffic adversarial bounds', () => {
  it('walks a deep junction chain iteratively', () => {
    const nodes: DraftNode[] = [service('start'), service('end')];
    const edges: DraftEdge[] = [];
    let previous = 'start';
    for (let index = 0; index < 2_000; index += 1) {
      const current = `j-${index}`;
      nodes.push(junction(current));
      edges.push(edge(`in-${index}`, previous, current));
      previous = current;
    }
    edges.push(edge('last', previous, 'end'));
    const result = analyzeTraffic({ nodes, edges });
    expect(result.truncated).toBe(false);
    expect(result.interactions).toHaveLength(1);
    expect(result.interactions[0]?.junctionIds).toHaveLength(2_000);
  });

  it('handles a large fan-out without path overflow', () => {
    const nodes: DraftNode[] = [service('source')];
    const edges: DraftEdge[] = [];
    for (let index = 0; index < 3_000; index += 1) {
      const id = `target-${index}`;
      nodes.push(service(id));
      edges.push(edge(`edge-${index}`, 'source', id));
    }
    const result = analyzeTraffic({ nodes, edges });
    expect(result.interactions).toHaveLength(3_000);
    expect(result.nodes.get('source')?.paths).toEqual({ definite: 1, possible: 1 });
  });

  it('saturates diamond paths at PATH_CAP', () => {
    const nodes: DraftNode[] = [service('start')];
    const edges: DraftEdge[] = [];
    let previous = ['start'];
    for (let level = 0; level < 30; level += 1) {
      const next = [`l-${level}-a`, `l-${level}-b`];
      next.forEach((id) => nodes.push(service(id)));
      for (const source of previous) for (const target of next) edges.push(edge(`${source}-${target}`, source, target));
      previous = next;
    }
    const result = analyzeTraffic({ nodes, edges });
    expect(result.nodes.get(previous[0]!)?.paths.possible).toBe(PATH_CAP);
    expect(result.nodes.get(previous[1]!)?.paths.possible).toBe(PATH_CAP);
  });

  it('analyzes 3,000 service stores plus 1,000 Junctions in fan-in/fan-out pairs under 1.5 seconds', () => {
    const nodes: DraftNode[] = [];
    const edges: DraftEdge[] = [];
    const shared = createNode({ type: 'database', id: 'shared', x: 0, y: 0, databaseKind: 'sql' });
    nodes.push(shared);
    for (let index = 0; index < 3_000; index += 1) {
      const source = service(`service-${index}`);
      const ownStore = createNode({ type: 'database', id: `store-${index}`, x: 0, y: 0, databaseKind: 'sql' });
      nodes.push(source, ownStore);
      edges.push(createEdge({ id: `service-${index}-own`, source: source.id, target: ownStore.id, semantic: 'writes' }));
      edges.push(createEdge({ id: `service-${index}-shared`, source: source.id, target: shared.id, semantic: 'writes' }));
    }
    for (let index = 0; index < 500; index += 1) {
      const left = junction(`fan-in-${index}`);
      const right = junction(`fan-out-${index}`);
      const sourceA = service(`fan-source-a-${index}`);
      const sourceB = service(`fan-source-b-${index}`);
      const targetA = service(`fan-target-a-${index}`);
      const targetB = service(`fan-target-b-${index}`);
      nodes.push(left, right, sourceA, sourceB, targetA, targetB);
      edges.push(
        createEdge({ id: `fan-${index}-a-in`, source: sourceA.id, target: left.id, semantic: 'calls' }),
        createEdge({ id: `fan-${index}-b-in`, source: sourceB.id, target: left.id, semantic: 'calls' }),
        createEdge({ id: `fan-${index}-junction`, source: left.id, target: right.id, semantic: 'calls' }),
        createEdge({ id: `fan-${index}-a-out`, source: right.id, target: targetA.id, semantic: 'calls' }),
        createEdge({ id: `fan-${index}-b-out`, source: right.id, target: targetB.id, semantic: 'calls' }),
      );
    }

    const started = performance.now();
    const result = analyzeTraffic({ nodes, edges });
    const elapsed = performance.now() - started;
    expect(result.nodes.get(shared.id)?.paths.definite).toBe(PATH_CAP);
    expect(elapsed).toBeLessThan(1_500);
  }, 5_000);

  it('finds the first baseline edge among 10,000 edges in under 5 milliseconds', () => {
    const serviceNode = service('hint-service');
    const database = createNode({ type: 'database', id: 'hint-database', x: 0, y: 0, databaseKind: 'sql' });
    const nodes = new Map([[serviceNode.id, serviceNode], [database.id, database]]);
    const edges = [createEdge({ id: 'first-baseline', source: serviceNode.id, target: database.id, semantic: 'reads' })];
    for (let index = 1; index < 10_000; index += 1) edges.push(createEdge({ id: `noise-${index}`, source: 'missing', target: 'also-missing', semantic: 'dependsOn' }));
    const started = performance.now();
    const result = mayHaveTraffic(nodes, edges);
    const elapsed = performance.now() - started;
    expect(result).toBe(true);
    expect(elapsed).toBeLessThan(5);
  });
});
