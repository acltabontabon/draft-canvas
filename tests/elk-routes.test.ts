import { describe, expect, it } from 'vitest';
import type { ElkNode } from 'elkjs';
import { withElkRoutes } from '../benchmark/adoption/elkRoutes';
import { createEdge, createNode } from '../src/document/factory';
import { connectorRoutes } from '../src/edges/connectorRoutes';

const nodes = () => [
  createNode({ id: 'a', type: 'service', x: 100, y: 200, width: 100, height: 70 }),
  createNode({ id: 'b', type: 'service', x: 400, y: 200, width: 100, height: 70 }),
];
const edge = () => createEdge({ id: 'ab', source: 'a', target: 'b' });
const graph = (): ElkNode => ({
  id: 'root',
  children: [{ id: 'group', x: 100, y: 200, edges: [{ id: 'ab', sources: ['a'], targets: ['b'], sections: [{ id: 'section', startPoint: { x: 100, y: 35 }, endPoint: { x: 300, y: 35 }, bendPoints: [{ x: 200, y: 35 }] }] }] }],
});

describe('ELK routing comparison adapter', () => {
  it('translates nested sections into native pins and bends without changing its inputs', () => {
    const input = { graph: graph(), nodes: nodes(), edges: [edge()] };
    const before = structuredClone(input);
    const result = withElkRoutes(input.graph, input.nodes, input.edges);
    expect(result.adapted).toBe(1);
    expect(result.edges[0]).toMatchObject({ sourceAnchor: { side: 'right', offset: 0.5 }, targetAnchor: { side: 'left', offset: 0.5 }, waypoints: [{ x: 300, y: 235 }] });
    const route = connectorRoutes(result.edges[0]!, { nodes: input.nodes, edges: result.edges }, 'transient')!.request;
    expect(route.source).toMatchObject({ x: 200, y: 235 });
    expect(route.target).toMatchObject({ x: 400, y: 235 });
    expect(input).toEqual(before);
  });

  it('keeps the baseline route when an ELK port is inside the artwork rather than on its border', () => {
    const input = graph();
    input.children![0]!.edges![0]!.sections![0]!.startPoint.x = 50;
    const original = edge();
    const result = withElkRoutes(input, nodes(), [original]);
    expect(result.adapted).toBe(0);
    expect(result.edges[0]).toBe(original);
  });

  it('reports unsupported compound junction sections instead of treating one branch as the entire route', () => {
    const input = graph();
    const sections = input.children![0]!.edges![0]!.sections!;
    sections.push({ ...sections[0]!, id: 'another-section' });
    const original = edge();
    const result = withElkRoutes(input, nodes(), [original]);
    expect(result.adapted).toBe(0);
    expect(result.edges[0]).toBe(original);
  });
});
