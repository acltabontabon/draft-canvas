import { describe, expect, it } from 'vitest';
import type { ElementDiffRow } from '../../src/agent/proposal';
import { reviewRows } from '../../src/desktop/ui/reviewRows';

/**
 * The review's change list for a re-layout that also groups and colours: one layout line for every
 * shape and connector that only moved, and the real changes named the way the diagram shows them.
 */

const DIFF: ElementDiffRow[] = [
  { kind: 'group', id: 'g_loan', change: 'added', label: 'Loan Domain' },
  { kind: 'element', id: 'svc', change: 'modified', label: 'Loan Account Service', fields: [{ field: 'y', before: '151', after: '5' }, { field: 'accent', after: 'blue' }, { field: 'parentId', after: 'g_loan' }] },
  { kind: 'element', id: 'db', change: 'modified', label: 'Loan database', fields: [{ field: 'x', before: '346', after: '280' }] },
  { kind: 'relationship', id: 'r1', change: 'modified', label: 'writes', fields: [{ field: 'sourceAnchor', before: 'right', after: 'bottom' }] },
];

describe('the review rows', () => {
  it('counts what only moved into one line and names the rest', () => {
    const names = new Map([['g_loan', 'Loan Domain']]);
    const { rows, layout } = reviewRows(DIFF, (id) => names.get(id));
    expect(layout).toBe('2 shapes moved · 1 connector rerouted');
    expect(rows.map((r) => r.id)).toEqual(['g_loan', 'svc']);
    expect(rows[1]!.fields).toEqual([
      { field: 'Colour', after: 'blue' },
      { field: 'Boundary', before: undefined, after: 'Loan Domain' },
    ]);
  });

  it('has no layout line when nothing moved', () => {
    expect(reviewRows([{ kind: 'element', id: 'a', change: 'modified', label: 'A', fields: [{ field: 'text', before: 'A', after: 'B' }] }], () => undefined).layout).toBeNull();
  });
});
