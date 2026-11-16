import { describe, expect, it } from 'vitest';
import { createEdge, createNode } from '../src/document/factory';
import { edgeIndex, nodeIndex } from '../src/store/selectors';

/**
 * The id indexes are shared by every node on every store change, and kept only for the few most
 * recent arrays: the undo history keeps every document it replaced, and an index for each of those
 * was megabytes held for lookups nobody would make again.
 */
describe('nodeIndex and edgeIndex', () => {
  const nodes = (count: number) => Array.from({ length: count }, (_, i) => createNode({ id: `n${i}`, type: 'service', x: i, y: 0 }));

  it('builds one index per array and shares it across every caller', () => {
    const list = nodes(40);
    const first = nodeIndex(list);
    expect(first.size).toBe(40);
    expect(first.get('n7')).toBe(list[7]);
    expect(nodeIndex(list)).toBe(first);
  });

  it('keeps the arrays in use, and answers correctly for one it let go of', () => {
    const current = nodes(30);
    const index = nodeIndex(current);
    // A long history of later documents, each looked up once as it was on screen.
    for (let step = 0; step < 50; step += 1) nodeIndex(nodes(30));
    const rebuilt = nodeIndex(current);
    expect(rebuilt).not.toBe(index);
    expect([...rebuilt.keys()]).toEqual([...index.keys()]);
    expect(rebuilt.get('n3')).toBe(current[3]);
  });

  it('keeps the few most recent: the document on screen beside its neighbours', () => {
    const lists = Array.from({ length: 5 }, () => nodes(10));
    const indexes = lists.map((list) => nodeIndex(list));
    lists.forEach((list, at) => expect(nodeIndex(list)).toBe(indexes[at]));
    // Asking for the oldest again keeps it the freshest.
    expect(nodeIndex(lists[0]!)).toBe(indexes[0]);
    expect(nodeIndex(lists[0]!)).toBe(indexes[0]);
  });

  it('does the same for connectors', () => {
    const [a, b, c] = nodes(3);
    const edges = [createEdge({ id: 'e1', source: a!.id, target: b!.id }), createEdge({ id: 'e2', source: b!.id, target: c!.id })];
    const index = edgeIndex(edges);
    expect(index.get('e2')).toBe(edges[1]);
    expect(edgeIndex(edges)).toBe(index);
    for (let step = 0; step < 20; step += 1) edgeIndex([createEdge({ id: `x${step}`, source: a!.id, target: b!.id })]);
    expect(edgeIndex(edges).get('e1')).toBe(edges[0]);
  });
});
