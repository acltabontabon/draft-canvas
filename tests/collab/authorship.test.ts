import { describe, expect, it } from 'vitest';
import { Authorship } from '../../src/collab/authorship';
import { addEdges, addNodes, removeElements, updateNode } from '../../src/document/operations';
import { createDocument, createEdge, createNode } from '../../src/document/factory';
import type { DraftDocument } from '../../src/document/types';

const node = (id: string, text = id) => createNode({ id, type: 'service', text, x: 0, y: 0 });
const ids = (file: DraftDocument) => file.nodes.map((n) => n.id).sort();
const edges = (file: DraftDocument) => file.edges.map((e) => e.id).sort();

/** A file and a ledger, edited by named people in turn. */
function session(start: DraftDocument) {
  const ledger = new Authorship();
  let file = start;
  return {
    ledger,
    get file() {
      return file;
    },
    edit(person: string, change: (file: DraftDocument) => DraftDocument) {
      const next = change(file);
      ledger.record(person, file, next);
      file = next;
    },
  };
}

describe('taking back one person’s changes', () => {
  it('keeps the unchanged starting tree retained while replacing one person’s touch', () => {
    const start = addNodes(createDocument('Shared'), [node('a'), node('b')]);
    const s = session(start);
    s.edit('gus', (file) => updateNode(file, 'a', { x: 10 }));
    const retained = (s.ledger as unknown as { retained: Map<object, unknown> }).retained;
    const beginning = retained.get(start);
    s.edit('gus', (file) => updateNode(file, 'a', { x: 20 }));
    expect(retained.get(start)).toBe(beginning);
    s.edit('gus', (file) => updateNode(file, 'a', { x: 0 }));
    expect(s.ledger.has('gus')).toBe(false);
    expect(retained.size).toBe(0);
  });

  it('bounds identities and file versions across people joining under fresh names', () => {
    const s = session(addNodes(createDocument('Churn'), [node('a')]));
    for (let i = 0; i < 200; i += 1) s.edit(`visitor${i}`, (file) => updateNode(file, 'a', { text: `Edit ${i}` }));
    const retained = s.ledger as unknown as { files: Map<DraftDocument, number> };
    expect(s.ledger.authors().length).toBeLessThanOrEqual(128);
    expect(retained.files.size).toBeLessThanOrEqual(128);
    expect(s.ledger.has('visitor0')).toBe(false);
    expect(s.ledger.has('visitor199')).toBe(true);
    expect(s.ledger.revert('visitor199', s.file).file.nodes[0]!.text).toBe('Edit 198');
    for (const person of s.ledger.authors()) s.ledger.forget(person);
    expect(retained.files.size).toBe(0);
    expect((s.ledger as unknown as { retainedBytes: number }).retainedBytes).toBe(0);
  });

  it('bounds retained contents as well as the number of versions', () => {
    const ledger = new Authorship();
    for (let i = 0; i < 50; i += 1) {
      const before = createDocument('Before');
      const after = addNodes(before, Array.from({ length: 4 }, (_, j) => createNode({ id: `code${i}_${j}`, type: 'code', code: `${i}_${j}`.padEnd(190_000, 'x'), x: 0, y: 0 })));
      ledger.record(`visitor${i}`, before, after);
    }
    expect((ledger as unknown as { retainedBytes: number }).retainedBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(ledger.forgotten('visitor0')).toBe(true);
    expect(ledger.has('visitor49')).toBe(true);
    for (const person of ledger.authors()) ledger.forget(person);
    expect((ledger as unknown as { retained: Map<object, unknown> }).retained.size).toBe(0);
  });

  it('reverts what they did and keeps what everyone else did', () => {
    const s = session(addNodes(createDocument('Shared'), [node('a'), node('b')]));
    s.edit('gus', (file) => removeElements(file, ['a']));
    s.edit('ada', (file) => addNodes(file, [node('c')]));
    s.edit('gus', (file) => updateNode(file, 'b', { text: 'Renamed by Gus' }));
    s.edit('gus', (file) => addNodes(file, [node('g')]));

    const result = s.ledger.revert('gus', s.file);
    expect(result).toMatchObject({ partial: false, blocked: false, kept: false });
    expect(ids(result.file)).toEqual(['a', 'b', 'c']);
    expect(result.file.nodes.find((n) => n.id === 'b')!.text).toBe('b');
  });

  it('takes back their connector along with their shape', () => {
    const s = session(addNodes(createDocument('Shared'), [node('a')]));
    s.edit('gus', (file) => addNodes(file, [node('g')]));
    s.edit('gus', (file) => addEdges(file, [createEdge({ id: 'e_g', source: 'a', target: 'g' })]));
    const result = s.ledger.revert('gus', s.file);
    expect(result.blocked).toBe(false);
    expect(ids(result.file)).toEqual(['a']);
    expect(edges(result.file)).toEqual([]);
  });

  it('leaves what someone else has changed since', () => {
    const s = session(addNodes(createDocument('Shared'), [node('a'), node('b')]));
    s.edit('gus', (file) => updateNode(file, 'a', { text: 'Gus' }));
    s.edit('gus', (file) => updateNode(file, 'b', { text: 'Gus' }));
    s.edit('ada', (file) => updateNode(file, 'a', { text: 'Ada' }));
    const result = s.ledger.revert('gus', s.file);
    expect(result.partial).toBe(true);
    expect(result.file.nodes.find((n) => n.id === 'a')!.text).toBe('Ada');
    expect(result.file.nodes.find((n) => n.id === 'b')!.text).toBe('b');
  });

  it('keeps a shape of theirs that someone else built on, and takes back the rest', () => {
    const s = session(addNodes(createDocument('Shared'), [node('a')]));
    s.edit('gus', (file) => addNodes(file, [node('g1')]));
    s.edit('gus', (file) => addNodes(file, [node('g2')]));
    s.edit('ada', (file) => addEdges(file, [createEdge({ id: 'e_ada', source: 'a', target: 'g2' })]));
    const result = s.ledger.revert('gus', s.file);
    expect(result).toMatchObject({ kept: true, blocked: false });
    expect(ids(result.file)).toEqual(['a', 'g2']);
    expect(edges(result.file)).toEqual(['e_ada']);
  });

  it('refuses when everything they did has been built on, and knows who changed nothing', () => {
    const s = session(addNodes(createDocument('Shared'), [node('a')]));
    s.edit('gus', (file) => addNodes(file, [node('g')]));
    s.edit('ada', (file) => addEdges(file, [createEdge({ id: 'e_ada', source: 'a', target: 'g' })]));
    const result = s.ledger.revert('gus', s.file);
    expect(result.blocked).toBe(true);
    expect(result.file).toBe(s.file);
    expect(s.ledger.has('gus')).toBe(true);
    expect(s.ledger.has('ada')).toBe(true);
    expect(s.ledger.has('nobody')).toBe(false);
    expect(s.ledger.revert('nobody', s.file).file).toBe(s.file);
  });

  it('lands on someone else’s version in between, never reaching past it', () => {
    const s = session(addNodes(createDocument('Shared'), [node('a')]));
    s.edit('gus', (file) => updateNode(file, 'a', { text: 'G1' }));
    s.edit('ada', (file) => updateNode(file, 'a', { text: 'Ada' }));
    s.edit('gus', (file) => updateNode(file, 'a', { text: 'G2' }));
    const result = s.ledger.revert('gus', s.file);
    expect(result.file.nodes.find((n) => n.id === 'a')!.text).toBe('Ada');
  });

  it('keeps the owner’s deletion when a late edit of theirs brought the shape back', () => {
    const s = session(addNodes(createDocument('Shared'), [node('a')]));
    s.edit('gus', (file) => updateNode(file, 'a', { text: 'Gus' }));
    s.edit('owner', (file) => removeElements(file, ['a']));
    s.edit('gus', (file) => addNodes(file, [node('a', 'Gus again')]));
    const result = s.ledger.revert('gus', s.file);
    expect(ids(result.file)).toEqual([]);
  });

  it('can be taken back again after an undo of the take-back', () => {
    const s = session(addNodes(createDocument('Shared'), [node('a')]));
    s.edit('gus', (file) => removeElements(file, ['a']));
    const before = s.file;
    const taken = s.ledger.revert('gus', s.file).file;
    expect(ids(taken)).toEqual(['a']);
    // The owner's undo puts Gus's removal back; taking it back works the same way again.
    expect(ids(s.ledger.revert('gus', before).file)).toEqual(['a']);
    // Against the taken-back file there is nothing left of Gus's to take.
    expect(s.ledger.revert('gus', taken).file).toBe(taken);
  });
});
