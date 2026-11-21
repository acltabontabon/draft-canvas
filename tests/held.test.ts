import { describe, expect, it } from 'vitest';
import { planArrange, planTidy } from '../src/agent/layoutPlan';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { fixedIds, heldCount } from '../src/document/held';
import { addEdges, addNodes } from '../src/document/operations';
import { parseDocument } from '../src/document/validate';
import { layoutNotes } from '../src/ui/Editor/arrangeSummary';

function tangle(held: string[] = []) {
  const at: Array<[string, number, number]> = [['a', 600, 400], ['b', 0, 0], ['c', 300, 520], ['d', 40, 300], ['e', 700, 40]];
  const nodes = at.map(([id, x, y]) => ({ ...createNode({ id, type: 'service', x, y, text: id.toUpperCase() }), ...(held.includes(id) ? { held: true } : {}) }));
  const edges = [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'e']].map(([source, target]) => createEdge({ id: `${source}${target}`, source: source!, target: target! }));
  return addEdges(addNodes(createDocument('Tangle'), nodes), edges);
}

describe('shapes held in place', () => {
  it('fix themselves, what a held boundary holds, and the boundaries around a held shape', () => {
    const group = { ...createNode({ id: 'g', type: 'group', x: 0, y: 0, width: 400, height: 300, text: 'Zone' }), held: true };
    const inside = createNode({ id: 'in', type: 'service', x: 40, y: 60, text: 'In', parentId: 'g' });
    const outer = createNode({ id: 'o', type: 'group', x: 600, y: 0, width: 400, height: 300, text: 'Other' });
    const pinned = { ...createNode({ id: 'p', type: 'service', x: 640, y: 60, text: 'P', parentId: 'o' }), held: true };
    const sibling = createNode({ id: 's', type: 'service', x: 800, y: 60, text: 'S', parentId: 'o' });
    const nodes = [group, inside, outer, pinned, sibling];
    expect([...fixedIds(nodes)].sort()).toEqual(['g', 'in', 'o', 'p']);
    expect(heldCount(nodes)).toBe(2);
    expect(fixedIds([inside, sibling]).size).toBe(0);
  });

  it('survive a save and a load, and mean nothing when absent', () => {
    const doc = tangle(['a']);
    const back = parseDocument(JSON.parse(JSON.stringify(doc))).document;
    expect(back.nodes.find((n) => n.id === 'a')!.held).toBe(true);
    expect('held' in back.nodes.find((n) => n.id === 'b')!).toBe(false);
  });

  it('stay exactly where they are when the rest is arranged around them', () => {
    const doc = tangle(['a']);
    const result = planArrange(doc);
    expect(result.kind).toBe('plan');
    if (result.kind !== 'plan') return;
    expect(result.plan.held).toBe(1);
    for (const view of Object.values(result.plan.options)) {
      const a = view!.nodes.find((n) => n.id === 'a')!;
      expect({ x: a.x, y: a.y }).toEqual({ x: 600, y: 400 });
      // …and something else did move, or there was nothing to preview.
      expect(view!.nodes.some((n) => n.id !== 'a' && (n.x !== doc.nodes.find((o) => o.id === n.id)!.x || n.y !== doc.nodes.find((o) => o.id === n.id)!.y))).toBe(true);
    }
  });

  it('are never nudged by Tidy up', () => {
    const a = { ...createNode({ id: 'a', type: 'service', x: 0, y: 0, text: 'A' }), held: true };
    const b = createNode({ id: 'b', type: 'service', x: 420, y: 9, text: 'B' });
    const doc = addEdges(addNodes(createDocument('Nearly'), [a, b]), [createEdge({ id: 'ab', source: 'a', target: 'b' })]);
    const result = planTidy(doc);
    const view = result.kind === 'plan' ? result.plan.view : doc;
    expect(view.nodes.find((n) => n.id === 'a')).toMatchObject({ x: 0, y: 0 });
  });

  it('are named in the bar, so nobody wonders why one shape did not move', () => {
    expect(layoutNotes({ held: 1, scoped: false }, 'arrange')).toEqual(['1 held shape stays where it is.']);
    expect(layoutNotes({ held: 3, scoped: false }, 'tidy')).toEqual(['3 held shapes stay where they are.']);
  });
});
