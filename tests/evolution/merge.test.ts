import { describe, expect, it } from 'vitest';
import { indexOf } from '../../src/collab/fileIndex';
import { diffFile } from '../../src/collab/diff';
import { keyOf } from '../../src/collab/changes';
import { sameValue } from '../../src/collab/equal';
import { createDocument, createEdge, createNode } from '../../src/document/factory';
import { addEdges, addNodes, updateEdge, updateNode } from '../../src/document/operations';
import type { DraftDocument } from '../../src/document/types';
import { merge } from '../../src/evolution/merge';
import { randomEdit, rngFrom, seededFile } from '../collab/support';

function base(): DraftDocument {
  let doc = createDocument('Payments');
  doc = addNodes(doc, [
    createNode({ type: 'service', x: 0, y: 0, id: 'a', text: 'API' }),
    createNode({ type: 'service', x: 300, y: 0, id: 'b', text: 'Orders' }),
    createNode({ type: 'database', x: 300, y: 200, id: 'c', text: 'DB' }),
  ]);
  return addEdges(doc, [createEdge({ id: 'e1', source: 'a', target: 'b' })]);
}

const ids = (doc: DraftDocument) => doc.nodes.map((node) => node.id).sort();
const node = (doc: DraftDocument, id: string) => indexOf(doc).nodes.get(id)?.value;

describe('the semantic merge', () => {
  it('combines independent additions', () => {
    const b = base();
    const ours = addNodes(b, [createNode({ type: 'queue', x: 0, y: 400, id: 'q', text: 'Events' })]);
    const theirs = addNodes(b, [createNode({ type: 'service', x: 600, y: 0, id: 's', text: 'Billing' })]);
    const result = merge(b, ours, theirs);
    expect(result.conflicts).toEqual([]);
    expect(ids(result.candidate)).toEqual(['a', 'b', 'c', 'q', 's']);
  });

  it('combines different units of the same shape', () => {
    const b = base();
    const ours = updateNode(b, 'a', { text: 'Gateway' });
    const theirs = updateNode(b, 'a', { x: 50, y: 20 });
    const result = merge(b, ours, theirs);
    expect(result.conflicts).toEqual([]);
    expect(node(result.candidate, 'a')).toMatchObject({ text: 'Gateway', x: 50, y: 20 });
  });

  it('never calls the same change on both sides a conflict', () => {
    const b = base();
    const both = updateNode(b, 'b', { text: 'Order Service' });
    expect(merge(b, both, both).conflicts).toEqual([]);
  });

  it('asks when both changed the same thing differently, and follows the choice', () => {
    const b = base();
    const ours = updateNode(b, 'b', { text: 'Orders v2' });
    const theirs = updateNode(b, 'b', { text: 'Ordering' });
    const result = merge(b, ours, theirs);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({ kind: 'both-changed', key: 'node:b', unit: 'text' });
    expect(node(result.candidate, 'b')!.text).toBe('Orders v2');
    const chosen = merge(b, ours, theirs, new Map([[result.conflicts[0]!.id, 'theirs']]));
    expect(node(chosen.candidate, 'b')!.text).toBe('Ordering');
  });

  it('treats geometry as one unit: two moves are one decision', () => {
    const b = base();
    const result = merge(b, updateNode(b, 'a', { x: 10 }), updateNode(b, 'a', { y: 10 }));
    expect(result.conflicts.map((conflict) => conflict.unit)).toEqual(['geometry']);
  });

  it('treats a connector’s ends as one unit', () => {
    const b = base();
    const ours = { ...b, edges: b.edges.map((edge) => (edge.id === 'e1' ? { ...edge, target: 'c' } : edge)) };
    const theirs = updateEdge(b, 'e1', { targetAnchor: { side: 'top', offset: 0.5 } });
    expect(merge(b, ours, theirs).conflicts.map((conflict) => conflict.unit)).toEqual(['ends']);
  });

  it('asks when one side removed what the other changed', () => {
    const b = base();
    const ours = { ...b, nodes: b.nodes.filter((n) => n.id !== 'c') };
    const theirs = updateNode(b, 'c', { text: 'Postgres' });
    expect(merge(b, ours, theirs).conflicts.map((conflict) => conflict.kind)).toEqual(['removed-and-changed']);
  });

  it('asks rather than drop a new connector to a removed shape', () => {
    const b = base();
    const ours = { ...b, nodes: b.nodes.filter((n) => n.id !== 'c') };
    const theirs = addEdges(b, [createEdge({ id: 'e2', source: 'b', target: 'c' })]);
    const result = merge(b, ours, theirs);
    expect(result.conflicts.map((conflict) => [conflict.kind, conflict.key])).toEqual([['combination', 'edge:e2']]);
  });

  // Past bug: a combination conflict offered "Keep this / Take X", but the candidate was always
  // `repairReferences`' output, so keeping the new connector still dropped it on Merge.
  it('follows the choice on a connector to a shape the other side removed', () => {
    const b = base();
    const ours = addEdges(b, [createEdge({ id: 'e2', source: 'b', target: 'c' })]);
    const theirs = { ...b, nodes: b.nodes.filter((n) => n.id !== 'c') };
    const unresolved = merge(b, ours, theirs);
    const conflict = unresolved.conflicts.find((c) => c.kind === 'combination')!;
    expect(conflict.key).toBe('edge:e2');
    const kept = merge(b, ours, theirs, new Map([[conflict.id, 'ours']]));
    expect(indexOf(kept.candidate).edges.has('e2')).toBe(true);
    expect(ids(kept.candidate)).toEqual(['a', 'b', 'c']);
    expect(kept.conflicts.map((c) => c.id)).toContain(conflict.id);
    const dropped = merge(b, ours, theirs, new Map([[conflict.id, 'theirs']]));
    expect(indexOf(dropped.candidate).edges.has('e2')).toBe(false);
    expect(ids(dropped.candidate)).toEqual(['a', 'b']);
    // The same, with the sides the other way round.
    const swapped = merge(b, theirs, ours, new Map([[conflict.id, 'theirs']]));
    expect(indexOf(swapped.candidate).edges.has('e2')).toBe(true);
    expect(ids(swapped.candidate)).toEqual(['a', 'b', 'c']);
  });

  it('keeps the other side’s own edits to a connector it keeps', () => {
    const b = base();
    const ours = { ...b, edges: b.edges.map((edge) => (edge.id === 'e1' ? { ...edge, target: 'c' } : edge)) };
    const theirs = updateEdge({ ...b, nodes: b.nodes.filter((n) => n.id !== 'c') }, 'e1', { label: 'calls' });
    const result = merge(b, ours, theirs);
    const conflict = result.conflicts.find((c) => c.kind === 'combination')!;
    expect(conflict.key).toBe('edge:e1');
    const kept = merge(b, ours, theirs, new Map([[conflict.id, 'ours']]));
    expect(indexOf(kept.candidate).edges.get('e1')?.value).toMatchObject({ source: 'a', target: 'c', label: 'calls' });
    const theirsWay = merge(b, ours, theirs, new Map([[conflict.id, 'theirs']]));
    expect(indexOf(theirsWay.candidate).edges.get('e1')?.value).toMatchObject({ source: 'a', target: 'b', label: 'calls' });
    expect(ids(theirsWay.candidate)).toEqual(['a', 'b']);
  });

  it('asks when both added different things under one identity', () => {
    const b = base();
    const ours = addNodes(b, [createNode({ type: 'queue', x: 0, y: 0, id: 'x', text: 'One' })]);
    const theirs = addNodes(b, [createNode({ type: 'queue', x: 0, y: 0, id: 'x', text: 'Two' })]);
    expect(merge(b, ours, theirs).conflicts.map((conflict) => conflict.kind)).toEqual(['same-id']);
  });

  it('finds a boundary the two sides together put inside itself', () => {
    let b = base();
    b = addNodes(b, [createNode({ type: 'group', x: -50, y: -50, width: 800, height: 600, id: 'g1', text: 'One' }), createNode({ type: 'group', x: 900, y: 0, width: 300, height: 300, id: 'g2', text: 'Two' })]);
    const ours = updateNode(b, 'g1', { parentId: 'g2' });
    const theirs = updateNode(b, 'g2', { parentId: 'g1' });
    const result = merge(b, ours, theirs);
    expect(result.conflicts.map((conflict) => conflict.kind)).toContain('combination');
    const conflict = result.conflicts.find((c) => c.kind === 'combination')!;
    const oursWay = merge(b, ours, theirs, new Map([[conflict.id, 'ours']])).candidate;
    expect([node(oursWay, 'g1')!.parentId, node(oursWay, 'g2')!.parentId]).toEqual(['g2', undefined]);
    const theirsWay = merge(b, ours, theirs, new Map([[conflict.id, 'theirs']])).candidate;
    expect([node(theirsWay, 'g1')!.parentId, node(theirsWay, 'g2')!.parentId]).toEqual([undefined, 'g1']);
  });

  it('keeps every change only one side made (seeded)', () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const rng = rngFrom(seed);
      const b = seededFile(rng, 8);
      let ours = b;
      let theirs = b;
      for (let i = 0; i < 4; i += 1) ours = randomEdit(ours, rng);
      for (let i = 0; i < 4; i += 1) theirs = randomEdit(theirs, rng);
      const result = merge(b, ours, theirs);
      const oursKeys = new Set(diffFile(b, ours).map(keyOf));
      const theirsKeys = new Set(diffFile(b, theirs).map(keyOf));
      const candidateIndex = indexOf(result.candidate);
      const conflicted = new Set(result.conflicts.map((conflict) => conflict.key));
      // A combination conflict also decides what its element refers to: a connector's ends, a
      // shape's boundaries. Resolved toward a side, those are that side's, removal or not.
      for (const conflict of result.conflicts) {
        if (conflict.kind !== 'combination') continue;
        const [kind, id] = conflict.key.split(':');
        for (const side of [b, ours, theirs]) {
          const index = indexOf(side);
          if (kind === 'edge') {
            const edge = index.edges.get(id!)?.value;
            if (edge) for (const end of [edge.source, edge.target]) conflicted.add(`node:${end}`);
          } else {
            const seen = new Set<string>();
            for (let parent = index.nodes.get(id!)?.value.parentId; parent && !seen.has(parent); parent = index.nodes.get(parent)?.value.parentId) {
              seen.add(parent);
              conflicted.add(`node:${parent}`);
            }
          }
        }
      }
      for (const [side, keys, other] of [
        [ours, oursKeys, theirsKeys],
        [theirs, theirsKeys, oursKeys],
      ] as const) {
        const sideIndex = indexOf(side);
        for (const key of keys) {
          if (other.has(key) || conflicted.has(key) || !key.startsWith('node:')) continue;
          const id = key.slice('node:'.length);
          const expected = sideIndex.nodes.get(id)?.value;
          const got = candidateIndex.nodes.get(id)?.value;
          if (!expected) {
            expect({ seed, key, present: got !== undefined }).toEqual({ seed, key, present: false });
          } else if (got) {
            const strip = ({ inside: _inside, ...rest }: typeof expected) => rest;
            expect({ seed, key, same: sameValue(strip(got), strip(expected)) }).toEqual({ seed, key, same: true });
          }
        }
      }
    }
  });
});
