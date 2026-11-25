import { describe, expect, it } from 'vitest';
import { applyChanges } from '../../src/collab/apply';
import { diffFile } from '../../src/collab/diff';
import { sanitizeChanges } from '../../src/collab/sanitize';
import { changeKeys } from '../../src/collab/selective';
import { createDocument, createNode } from '../../src/document/factory';
import { addNodes, removeElements } from '../../src/document/operations';
import type { DraftDocument, DraftNode } from '../../src/document/types';
import { parseDocument } from '../../src/document/validate';
import { counterpartsOf, linkJunctions, membersOf, renameJunctionGroup, unlinkJunctions } from '../../src/junctions/groups';
import { sharedContent } from './support';

const junction = (id: string, x: number, extra: Partial<DraftNode> = {}): DraftNode => ({ ...createNode({ id, type: 'ellipse', x, y: 0, text: 'A' }), ...extra });

function shared(): DraftDocument {
  const orders: DraftNode = {
    ...createNode({ id: 'orders', type: 'service', x: 0, y: 400, text: 'Orders' }),
    inside: { nodes: [junction('deep', 0, { link: 'pay' })], edges: [], flows: [], viewport: { x: 0, y: 0, zoom: 1 } },
  };
  return addNodes(createDocument('Shared'), [junction('a', 0, { link: 'pay' }), junction('b', 900, { link: 'pay' }), orders]);
}

/** What a collaborator's edit is on the wire, and what the owner makes of it. */
const sent = (before: DraftDocument, after: DraftDocument) => {
  const result = sanitizeChanges(JSON.parse(JSON.stringify(diffFile(before, after))));
  if (!result.ok) throw new Error(result.reason);
  return result.changes;
};

describe('linked junctions in a shared session', () => {
  it('a link travels as part of its junction, and arrives as it was sent', () => {
    const base = addNodes(createDocument('Shared'), [junction('a', 0), junction('b', 900)]);
    const linked = linkJunctions(base, ['a', 'b']).file;
    const changes = sent(base, linked);
    expect(changes).toEqual(JSON.parse(JSON.stringify(diffFile(base, linked))));
    const received = applyChanges(base, changes);
    expect(sharedContent(received)).toEqual(sharedContent(linked));
    expect(counterpartsOf(received, 'a').map((member) => member.node.id)).toEqual(['b']);
  });

  it('a rename reaches every room, and undoes as the junctions it touched', () => {
    const base = shared();
    const renamed = renameJunctionGroup(base, 'pay', 'Settle');
    const received = applyChanges(base, sent(base, renamed));
    expect(membersOf(received, 'pay').map((member) => [member.node.id, member.node.text])).toEqual([
      ['a', 'Settle'],
      ['b', 'Settle'],
      ['deep', 'Settle'],
    ]);
    // What a selective undo takes back: each junction, by its own key.
    expect(changeKeys(base, renamed).sort()).toEqual(['node:a', 'node:b', 'node:deep']);
  });

  it('refuses a link on anything but a junction, and one that is no usable id', () => {
    const base = shared();
    const forged = diffFile(base, addNodes(base, [createNode({ id: 'svc', type: 'service', x: 0, y: 900, text: 'Billing' })]));
    const raw = JSON.parse(JSON.stringify(forged)) as Array<{ kind: string; value: Record<string, unknown> }>;
    raw.find((change) => change.kind === 'node')!.value.link = 'pay';
    const result = sanitizeChanges(raw);
    if (!result.ok) throw new Error(result.reason);
    const received = applyChanges(base, result.changes);
    expect('link' in received.nodes.find((node) => node.id === 'svc')!).toBe(false);
    expect(membersOf(received, 'pay')).toHaveLength(3);

    const bad = JSON.parse(JSON.stringify(diffFile(base, addNodes(base, [junction('c', 1800, { link: 'pay' })])))) as Array<{ kind: string; value: Record<string, unknown> }>;
    bad.find((change) => change.kind === 'node')!.value.link = { nested: 'pay' };
    const cleaned = sanitizeChanges(bad);
    if (!cleaned.ok) throw new Error(cleaned.reason);
    expect('link' in applyChanges(base, cleaned.changes).nodes.find((node) => node.id === 'c')!).toBe(false);
  });

  it('two people at once: a rename and a new counterpart both land, in one group', () => {
    const base = shared();
    const renamed = renameJunctionGroup(base, 'pay', 'Settle');
    const added = addNodes(base, [junction('theirs', 1800, { link: 'pay' })]);
    // The owner applies one, then the other; the order they arrive in does not change who is in the group.
    for (const [first, second] of [[renamed, added], [added, renamed]] as const) {
      const merged = applyChanges(applyChanges(base, sent(base, first)), sent(base, second));
      expect(membersOf(merged, 'pay').map((member) => member.node.id).sort()).toEqual(['a', 'b', 'deep', 'theirs']);
      // The newcomer was drawn with the old label. It is still one group: identity is the link, and
      // the next rename writes one label on all four.
      expect(membersOf(merged, 'pay').find((member) => member.node.id === 'theirs')!.node.text).toBe('A');
      const settled = renameJunctionGroup(merged, 'pay', 'Settle');
      expect(new Set(membersOf(settled, 'pay').map((member) => member.node.text))).toEqual(new Set(['Settle']));
      const parsed = parseDocument(JSON.parse(JSON.stringify(merged)));
      expect(parsed.ok && parsed.repairs).toEqual([]);
    }
  });

  it('two people at once: one unlinks a junction another deletes, and nothing dangles', () => {
    const base = shared();
    const unlinked = unlinkJunctions(base, ['b']);
    const deleted = removeElements(base, ['b']);
    for (const [first, second] of [[unlinked, deleted], [deleted, unlinked]] as const) {
      const merged = applyChanges(applyChanges(base, sent(base, first)), sent(base, second));
      const parsed = parseDocument(JSON.parse(JSON.stringify(merged)));
      expect(parsed.ok && parsed.repairs).toEqual([]);
      expect(membersOf(merged, 'pay').map((member) => member.node.id)).toEqual(expect.arrayContaining(['a', 'deep']));
      expect(membersOf(merged, 'pay').some((member) => member.node.id === 'b')).toBe(false);
    }
  });
});
