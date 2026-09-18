import { describe, expect, it } from 'vitest';
import { RECALL_LIMIT, recallItems, shouldRecall, type RecallSource } from '../src/takeaways/recall';
import type { Takeaways } from '../src/takeaways/collect';
import type { DraftAction } from '../src/document/types';

/** Every clause of the rule is a "no", so the base case is the one that says yes. */
const ARRIVING: RecallSource = {
  reopening: false,
  presenting: false,
  alreadyOpen: false,
  revealing: false,
  openCount: 3,
};

function takeaways(actions: DraftAction[]): Takeaways {
  return { decisions: [], questions: [], actions: actions.map((action) => ({ action })) };
}

function open(n: number): DraftAction[] {
  return Array.from({ length: n }, (_, i) => ({ id: `a_${i}`, text: `Action ${i}` }));
}

describe('shouldRecall', () => {
  it('speaks up when a canvas arrives owing something', () => {
    expect(shouldRecall(ARRIVING)).toBe(true);
  });

  it('says nothing when nothing is open', () => {
    expect(shouldRecall({ ...ARRIVING, openCount: 0 })).toBe(false);
  });

  it('says nothing when the same canvas arrives again', () => {
    // VS Code reloading the file, or taking another tab's copy: nothing changed for the person
    // watching, so there is no arrival to mark.
    expect(shouldRecall({ ...ARRIVING, reopening: true })).toBe(false);
  });

  it('says nothing while presenting', () => {
    expect(shouldRecall({ ...ARRIVING, presenting: true })).toBe(false);
  });

  it('says nothing when the panel is already up', () => {
    expect(shouldRecall({ ...ARRIVING, alreadyOpen: true })).toBe(false);
  });

  it('says nothing when the open came from clicking one of these actions', () => {
    // The whole point of the band: you just read it. Being told again on arrival is the
    // redundancy this feature exists to avoid.
    expect(shouldRecall({ ...ARRIVING, revealing: true })).toBe(false);
  });
});

describe('recallItems', () => {
  it('lists open actions and counts the rest', () => {
    const items = recallItems(takeaways(open(5)));
    expect(items.shown).toHaveLength(RECALL_LIMIT);
    expect(items.overflow).toBe(5 - RECALL_LIMIT);
    expect(items.total).toBe(5);
  });

  it('does not overflow when everything fits', () => {
    const items = recallItems(takeaways(open(2)));
    expect(items.shown).toHaveLength(2);
    expect(items.overflow).toBe(0);
  });

  it('ignores actions already done — they are not still open', () => {
    const items = recallItems(takeaways([...open(2), { id: 'a_done', text: 'Done', done: true }]));
    expect(items.total).toBe(2);
    expect(items.shown.map((entry) => entry.action.id)).toEqual(['a_0', 'a_1']);
  });

  it('keeps capture order — the order things were said in', () => {
    const items = recallItems(takeaways(open(3)));
    expect(items.shown.map((entry) => entry.action.text)).toEqual(['Action 0', 'Action 1', 'Action 2']);
  });
});
