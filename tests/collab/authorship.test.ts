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
