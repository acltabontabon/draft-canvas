import { describe, expect, it } from 'vitest';
import { isActivatableTarget, isEditableTarget } from '../src/lib/isEditableTarget';

function input(type: string): HTMLInputElement {
  const element = document.createElement('input');
  element.type = type;
  return element;
}

describe('isEditableTarget', () => {
  it('counts fields you type into — and inputs whose arrow keys are their own', () => {
    for (const type of ['text', 'search', 'number', 'email', 'range', 'radio']) {
      expect(isEditableTarget(input(type))).toBe(true);
    }
    expect(isEditableTarget(document.createElement('textarea'))).toBe(true);
    expect(isEditableTarget(document.createElement('select'))).toBe(true);
  });

  it("doesn't count a focused checkbox, so editor shortcuts keep working after toggling one", () => {
    expect(isEditableTarget(input('checkbox'))).toBe(false);
    expect(isEditableTarget(document.createElement('button'))).toBe(false);
    // …while Space/Enter on it still belong to the checkbox, not to a global shortcut.
    expect(isActivatableTarget(input('checkbox'))).toBe(true);
  });
});
