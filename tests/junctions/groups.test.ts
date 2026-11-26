import { describe, expect, it } from 'vitest';
import { createDocument, createEdge, createNode } from '../../src/document/factory';
import { addEdges, addNodes, extractFragment, pasteFragment, removeElements } from '../../src/document/operations';
import { CURRENT_VERSION, type DraftDocument, type DraftNode } from '../../src/document/types';
import { parseDocument } from '../../src/document/validate';
import { serializeDocument } from '../../src/export/project';
import {
  counterpartsOf,
  diameterFor,
  groupLabel,
  junctionGroups,
  junctionIndex,
  junctionOf,
  letterLabel,
  linkJunctions,
  membersOf,
  nextJunctionLabel,
  renameJunctionGroup,
  sameLabelJunctions,
  unlinkJunctions,
} from '../../src/junctions/groups';

const junction = (id: string, x: number, y: number, extra: Partial<DraftNode> = {}): DraftNode => ({ ...createNode({ id, type: 'ellipse', x, y }), ...extra });

/** A file with a top level and one room, inside the service `orders`. */
function fileWith(top: DraftNode[], inside: DraftNode[] = []): DraftDocument {
  const orders: DraftNode = { ...createNode({ id: 'orders', type: 'service', x: 0, y: 600, text: 'Orders' }) };
  if (inside.length > 0) orders.inside = { nodes: inside, edges: [], flows: [], viewport: { x: 0, y: 0, zoom: 1 } };
  return addNodes(createDocument('Junctions'), [...top, orders]);
}

const reload = (file: DraftDocument): DraftDocument => {
  const parsed = parseDocument(JSON.parse(JSON.stringify(file)));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.document;
};

describe('a junction group', () => {
  it('is the junctions that share a link, wherever in the file they are', () => {
    const file = fileWith(
      [junction('a1', 0, 0, { link: 'pay', text: 'A' }), junction('a2', 900, 0, { link: 'pay', text: 'A' }), junction('lone', 40, 40)],
      [junction('a3', 10, 10, { link: 'pay', text: 'A' })],
    );
    expect(membersOf(file, 'pay').map((member) => member.node.id)).toEqual(['a1', 'a2', 'a3']);
    expect(membersOf(file, 'pay').map((member) => member.path)).toEqual([[], [], ['orders']]);
    expect(junctionOf(file, 'a3')?.owners.map((owner) => owner.id)).toEqual(['orders']);
    expect(membersOf(file, 'nothing')).toEqual([]);
    expect(membersOf(file, undefined)).toEqual([]);
    // Unlinked junctions are known, and belong to no group.
    expect(junctionOf(file, 'lone')?.node.link).toBeUndefined();
    expect([...junctionIndex(file).groups.keys()]).toEqual(['pay']);
  });

  it('is identified by its link, never its label: two groups may both read "A"', () => {
    const file = fileWith([
      junction('p1', 0, 0, { link: 'payments', text: 'A' }),
      junction('p2', 900, 0, { link: 'payments', text: 'A' }),
      junction('s1', 0, 300, { link: 'shipping', text: 'A' }),
      junction('s2', 900, 300, { link: 'shipping', text: 'A' }),
    ]);
    expect(counterpartsOf(file, 'p1').map((member) => member.node.id)).toEqual(['p2']);
    expect(counterpartsOf(file, 's1').map((member) => member.node.id)).toEqual(['s2']);
    expect(junctionGroups(file).map((group) => [group.link, group.label, group.count])).toEqual([
      ['payments', 'A', 2],
      ['shipping', 'A', 2],
    ]);
  });

  it('lists where a junction continues without itself, its own room first, in reading order', () => {
    const file = fileWith(
      [
        junction('origin', 500, 500, { link: 'g' }),
        junction('below', 100, 900, { link: 'g' }),
        junction('right', 900, 100, { link: 'g' }),
        junction('left', 100, 100, { link: 'g' }),
      ],
      [junction('deep', 0, 0, { link: 'g' })],
    );
    const order = counterpartsOf(file, 'origin').map((member) => member.node.id);
    expect(order).toEqual(['left', 'right', 'below', 'deep']);
    // The same file, asked again, answers the same.
    expect(counterpartsOf(file, 'origin').map((member) => member.node.id)).toEqual(order);
    // Seen from inside the room, the room's own members would lead.
    expect(counterpartsOf(file, 'deep').map((member) => member.node.id)).toEqual(['left', 'right', 'origin', 'below']);
  });

  it('has no counterparts for a standalone junction, a group of one, or anything that is not a junction', () => {
    const file = fileWith([junction('plain', 0, 0), junction('waiting', 100, 0, { link: 'solo' })]);
    expect(counterpartsOf(file, 'plain')).toEqual([]);
    expect(counterpartsOf(file, 'waiting')).toEqual([]);
    expect(counterpartsOf(file, 'orders')).toEqual([]);
    expect(counterpartsOf(file, 'missing')).toEqual([]);
  });

  it('is indexed once per file and again only when the file changes', () => {
    const file = fileWith([junction('a', 0, 0, { link: 'g' })]);
    expect(junctionIndex(file)).toBe(junctionIndex(file));
    const moved = { ...file, nodes: file.nodes.map((node) => (node.id === 'a' ? { ...node, x: 5 } : node)) };
    expect(junctionIndex(moved)).not.toBe(junctionIndex(file));
  });
});

describe('labels', () => {
  it('run A to Z and on through AA, AB, like a spreadsheet’s columns', () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(letterLabel)).toEqual(['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA']);
  });

  it('suggest the first letter no junction already carries, whatever its case and whether or not it is linked', () => {
    expect(nextJunctionLabel(fileWith([]))).toBe('A');
    const file = fileWith([junction('a', 0, 0, { text: 'A' }), junction('b', 0, 0, { text: 'b', link: 'g' })], [junction('c', 0, 0, { text: 'C' })]);
    expect(nextJunctionLabel(file)).toBe('D');
    // A custom label takes no letter out of the sequence.
    expect(nextJunctionLabel(fileWith([junction('x', 0, 0, { text: 'Payments' })]))).toBe('A');
    const all = Array.from({ length: 26 }, (_, i) => junction(`j${i}`, i * 50, 0, { text: letterLabel(i) }));
    expect(nextJunctionLabel(fileWith(all))).toBe('AA');
  });

  it('give a short word room, up to a junction’s own ceiling, and never take size away', () => {
    expect(diameterFor('A', 36)).toBe(36);
    expect(diameterFor('AB', 36)).toBe(36);
    expect(diameterFor('Pay', 36)).toBeGreaterThan(36);
    expect(diameterFor('A very long label', 36)).toBe(64);
    expect(diameterFor('Pay', 60)).toBe(60);
  });
});

describe('linking', () => {
  it('starts a group with the next free letter and writes it on every junction joining', () => {
    const file = fileWith([junction('a', 0, 0), junction('b', 900, 0), junction('taken', 0, 300, { text: 'A' })]);
    const result = linkJunctions(file, ['a', 'b']);
    expect(result.link).toMatch(/^j_/);
    expect(result.label).toBe('B');
    const linked = membersOf(result.file, result.link!);
    expect(linked.map((member) => [member.node.id, member.node.text, member.node.textOrigin])).toEqual([
      ['a', 'B', 'explicit'],
      ['b', 'B', 'explicit'],
    ]);
    // Nobody else was touched.
    expect(junctionOf(result.file, 'taken')?.node).toBe(junctionOf(file, 'taken')?.node);
  });

  it('keeps a label somebody already chose, and joins the group one of them is in', () => {
    const file = fileWith([junction('named', 0, 0, { text: 'Settle' }), junction('blank', 900, 0)]);
    const named = linkJunctions(file, ['named', 'blank']);
    expect(named.label).toBe('Settle');
    expect(groupLabel(membersOf(named.file, named.link!))).toBe('Settle');

    const third = addNodes(named.file, [junction('third', 0, 900, { text: 'Other' })]);
    const joined = linkJunctions(third, ['third', 'named']);
    // `named` already has a group: `third` joins it and takes its label.
    expect(joined.link).toBe(named.link);
    expect(membersOf(joined.file, joined.link!).map((member) => member.node.text)).toEqual(['Settle', 'Settle', 'Settle']);
  });

  it('joins a named group, taking only the junction asked for out of the one it was in', () => {
    const file = fileWith([
      junction('p1', 0, 0, { link: 'pay', text: 'A' }),
      junction('p2', 900, 0, { link: 'pay', text: 'A' }),
      junction('s1', 0, 300, { link: 'ship', text: 'B' }),
      junction('s2', 900, 300, { link: 'ship', text: 'B' }),
    ]);
    const result = linkJunctions(file, ['s2'], 'pay');
    expect(membersOf(result.file, 'pay').map((member) => member.node.id)).toEqual(['p1', 'p2', 's2']);
    expect(membersOf(result.file, 'ship').map((member) => member.node.id)).toEqual(['s1']);
    expect(junctionOf(result.file, 's2')?.node.text).toBe('A');
  });

  it('reaches across rooms, and leaves the file alone when there is nothing to link', () => {
    const file = fileWith([junction('top', 0, 0)], [junction('deep', 0, 0)]);
    const result = linkJunctions(file, ['top', 'deep']);
    expect(membersOf(result.file, result.link!).map((member) => member.path)).toEqual([[], ['orders']]);
    const nothing = linkJunctions(file, ['orders', 'missing']);
    expect(nothing.link).toBeNull();
    expect(nothing.file).toBe(file);
    // Already exactly so: the same file comes back, so no undo step is made of it.
    const again = linkJunctions(result.file, ['top', 'deep']);
    expect(again.file).toBe(result.file);
  });

  it('unlinks one junction and keeps the shape, its label and everyone else’s link', () => {
    const file = fileWith([junction('a', 0, 0, { link: 'g', text: 'A' }), junction('b', 900, 0, { link: 'g', text: 'A' }), junction('c', 0, 900, { link: 'g', text: 'A' })]);
    const next = unlinkJunctions(file, ['b']);
    const b = junctionOf(next, 'b')!.node;
    expect('link' in b).toBe(false);
    expect(b.text).toBe('A');
    expect(membersOf(next, 'g').map((member) => member.node.id)).toEqual(['a', 'c']);
    expect(unlinkJunctions(next, ['b', 'orders'])).toBe(next);
  });

  it('renames a group everywhere it is drawn, and no other group that reads the same', () => {
    const file = fileWith(
      [junction('a1', 0, 0, { link: 'g', text: 'A' }), junction('other', 300, 0, { link: 'h', text: 'A' })],
      [junction('a2', 0, 0, { link: 'g', text: 'A' })],
    );
    const next = renameJunctionGroup(file, 'g', '  Settle   payment ');
    expect(membersOf(next, 'g').map((member) => member.node.text)).toEqual(['Settle payment', 'Settle payment']);
    expect(junctionOf(next, 'other')?.node.text).toBe('A');
    // Grown about its own middle to hold the longer word, so its connectors stay where they were.
    const before = junctionOf(file, 'a1')!.node;
    const after = junctionOf(next, 'a1')!.node;
    expect(after.width).toBeGreaterThan(before.width);
    expect(after.x + after.width / 2).toBeCloseTo(before.x + before.width / 2, 0);
    expect(renameJunctionGroup(next, 'g', 'Settle payment')).toBe(next);
  });

  it('offers junctions that read the same without being linked, and never links them itself', () => {
    const file = fileWith([
      junction('a', 0, 0, { text: 'A' }),
      junction('same', 900, 0, { text: 'a' }),
      junction('linkedElsewhere', 0, 300, { text: 'A', link: 'other' }),
      junction('different', 0, 600, { text: 'B' }),
      junction('blank', 0, 900),
    ]);
    expect(sameLabelJunctions(file, 'a').map((member) => member.node.id)).toEqual(['same', 'linkedElsewhere']);
    expect(sameLabelJunctions(file, 'blank')).toEqual([]);
    const linked = linkJunctions(file, ['a', 'same']).file;
    // Its own group is no longer "the same label, unlinked"; the other group still is.
    expect(sameLabelJunctions(linked, 'a').map((member) => member.node.id)).toEqual(['linkedElsewhere']);
  });
});

describe('a link in the file', () => {
  it('survives a save and a load, on a junction and nothing else', () => {
    const file = fileWith([junction('a', 0, 0, { link: 'pay', text: 'A' })], [junction('b', 0, 0, { link: 'pay', text: 'A' })]);
    const service = { ...createNode({ id: 'svc', type: 'service', x: 0, y: 0 }), link: 'pay' } as DraftNode;
    const back = reload(addNodes(file, [service]));
    expect(back.version).toBe(CURRENT_VERSION);
    expect(membersOf(back, 'pay').map((member) => member.node.id)).toEqual(['a', 'b']);
    expect('link' in back.nodes.find((node) => node.id === 'svc')!).toBe(false);
    // Written where the canonical order puts it, and read back the same.
    expect(reload(JSON.parse(serializeDocument(back)) as DraftDocument)).toEqual(back);
  });

  it('drops a link that is not a usable id, and keeps the junction', () => {
    const raw = JSON.parse(JSON.stringify(fileWith([junction('a', 0, 0)]))) as { nodes: Array<Record<string, unknown>> };
    for (const bad of [42, '', '   ', 'x'.repeat(200), null, { id: 'g' }]) {
      raw.nodes[0]!.link = bad;
      const parsed = parseDocument(raw);
      if (!parsed.ok) throw new Error(parsed.error);
      expect('link' in parsed.document.nodes[0]!).toBe(false);
      expect(parsed.document.nodes[0]!.type).toBe('ellipse');
    }
  });

  it('is never guessed for a file written before links: matching labels stay unlinked, however often it is opened', () => {
    const old = JSON.parse(JSON.stringify(fileWith([junction('a', 0, 0, { text: 'A' }), junction('b', 900, 0, { text: 'A' })]))) as Record<string, unknown>;
    old.version = 32;
    const once = parseDocument(old);
    if (!once.ok) throw new Error(once.error);
    expect(once.document.version).toBe(CURRENT_VERSION);
    expect(once.document.nodes.filter((node) => node.link)).toEqual([]);
    expect([...junctionIndex(once.document).groups.keys()]).toEqual([]);
    // Opening it again changes nothing more.
    expect(reload(once.document).nodes).toEqual(once.document.nodes);
    // What is offered instead is the explicit link.
    expect(sameLabelJunctions(once.document, 'a').map((member) => member.node.id)).toEqual(['b']);
  });

  it('keeps its group when two junctions in a file are given the same id: the second is renamed, not unlinked', () => {
    const raw = JSON.parse(JSON.stringify(fileWith([junction('dup', 0, 0, { link: 'g', text: 'A' }), junction('dup', 900, 0, { link: 'g', text: 'A' })]))) as Record<string, unknown>;
    const parsed = parseDocument(raw);
    if (!parsed.ok) throw new Error(parsed.error);
    const members = membersOf(parsed.document, 'g');
    expect(members).toHaveLength(2);
    expect(new Set(members.map((member) => member.node.id)).size).toBe(2);
  });

  it('is not a connector: deleting one junction leaves the other, waiting, and removes nothing else', () => {
    const service = createNode({ id: 'svc', type: 'service', x: 200, y: 0, text: 'Billing' });
    const file = addEdges(addNodes(createDocument('D'), [junction('a', 0, 0, { link: 'g', text: 'A' }), junction('b', 900, 0, { link: 'g', text: 'A' }), service]), [
      createEdge({ id: 'e', source: 'b', target: 'svc' }),
    ]);
    const next = removeElements(file, ['a']);
    expect(next.edges.map((edge) => edge.id)).toEqual(['e']);
    expect(junctionOf(next, 'b')?.node.link).toBe('g');
    expect(counterpartsOf(next, 'b')).toEqual([]);
    // Put back (an undo, a paste), it is the same group again.
    expect(counterpartsOf(file, 'b').map((member) => member.node.id)).toEqual(['a']);
  });
});

describe('copying linked junctions', () => {
  const pair = () => addNodes(createDocument('D'), [junction('a', 0, 0, { link: 'g', text: 'A' }), junction('b', 900, 0, { link: 'g', text: 'A' }), junction('c', 0, 900, { link: 'h', text: 'B' })]);

  it('a junction copied alone is one more place its group is drawn', () => {
    const file = pair();
    const result = pasteFragment(file, extractFragment(file, ['a']), { x: 24, y: 24 });
    expect(membersOf(result.doc, 'g')).toHaveLength(3);
    expect(result.doc.nodes.find((node) => node.id === result.nodeIds[0])?.link).toBe('g');
  });

  it('a group copied together becomes a group of its own, apart from the one it was copied from', () => {
    const file = pair();
    const result = pasteFragment(file, extractFragment(file, ['a', 'b', 'c']), { x: 24, y: 24 });
    const copies = result.nodeIds.map((id) => result.doc.nodes.find((node) => node.id === id)!);
    const [copyA, copyB, copyC] = copies;
    expect(copyA!.link).toBe(copyB!.link);
    expect(copyA!.link).not.toBe('g');
    expect(copyA!.link).toMatch(/^j_/);
    // `c` was copied alone: it stays in the group it came from.
    expect(copyC!.link).toBe('h');
    expect(membersOf(result.doc, 'g').map((member) => member.node.id)).toEqual(['a', 'b']);
    expect(counterpartsOf(result.doc, copyA!.id).map((member) => member.node.id)).toEqual([copyB!.id]);
    // Pasted a second time, the second copy is its own group again.
    const twice = pasteFragment(result.doc, extractFragment(file, ['a', 'b']), { x: 48, y: 48 });
    const links = new Set(twice.doc.nodes.filter((node) => node.type === 'ellipse').map((node) => node.link));
    expect(links.size).toBe(4);
  });

  it('counts the junctions inside a copied shape’s rooms too', () => {
    const file = fileWith([junction('top', 0, 0, { link: 'g', text: 'A' })], [junction('deep', 0, 0, { link: 'g', text: 'A' })]);
    const result = pasteFragment(file, extractFragment(file, ['top', 'orders']), { x: 400, y: 0 });
    const copiedTop = result.doc.nodes.find((node) => node.id === result.nodeIds[0])!;
    const copiedOrders = result.doc.nodes.find((node) => node.id === result.nodeIds[1])!;
    expect(copiedTop.link).not.toBe('g');
    expect(copiedOrders.inside!.nodes[0]!.link).toBe(copiedTop.link);
    expect(membersOf(result.doc, 'g')).toHaveLength(2);
  });

  it('pasted into another diagram, a lone junction waits for a counterpart and a pair stays a pair', () => {
    const file = pair();
    const elsewhere = createDocument('Elsewhere');
    const lone = pasteFragment(elsewhere, extractFragment(file, ['a']), { x: 0, y: 0 });
    expect(counterpartsOf(lone.doc, lone.nodeIds[0]!)).toEqual([]);
    expect(lone.doc.nodes[0]!.link).toBe('g');
    const both = pasteFragment(elsewhere, extractFragment(file, ['a', 'b']), { x: 0, y: 0 });
    expect(counterpartsOf(both.doc, both.nodeIds[0]!).map((member) => member.node.id)).toEqual([both.nodeIds[1]]);
  });
});
