import { describe, expect, it } from 'vitest';
import { shouldRecall, type RecallSource } from '../src/takeaways/recall';

/** Every clause of the rule is a "no", so the base case is the one that says yes. */
const ARRIVING: RecallSource = {
  reopening: false,
  presenting: false,
  alreadyOpen: false,
  openCount: 3,
};

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
});
