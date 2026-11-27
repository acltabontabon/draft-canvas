import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { focusPlacedByPointer, watchFocusOrigin } from '../src/ui/Editor/focusOrigin';

/**
 * How focus reached a control is decided when it arrives. Chromium turns `:focus-visible` on for the
 * focused element as soon as a key goes down, before the page's keydown handlers run, so the editor's
 * bare-key guard asking at keydown took every clicked button for one reached from the keyboard.
 */
describe('focusOrigin', () => {
  beforeAll(() => watchFocusOrigin());
  afterEach(() => {
    document.body.replaceChildren();
  });

  function buttons(...names: string[]) {
    return names.map((name) => {
      const button = document.createElement('button');
      button.textContent = name;
      document.body.append(button);
      return button;
    });
  }
  const press = (key: string, init: KeyboardEventInit = {}) => window.dispatchEvent(new KeyboardEvent('keydown', { key, ...init }));
  const pointerDown = () => window.dispatchEvent(new Event('pointerdown'));

  it('counts a button focused by a pointer press as placed by the pointer, through keys pressed on it', () => {
    const [zoomIn] = buttons('Zoom in');
    pointerDown();
    zoomIn!.focus();
    expect(focusPlacedByPointer(zoomIn!)).toBe(true);
    // The key that asks does not change how focus got there.
    press('Delete');
    expect(focusPlacedByPointer(zoomIn!)).toBe(true);
  });

  it('counts focus moved by the keyboard, or by a script acting on a key, as the keyboard’s', () => {
    const [chip, share] = buttons('History', 'Share');
    pointerDown();
    chip!.focus();
    press('Tab');
    share!.focus();
    expect(focusPlacedByPointer(share!)).toBe(false);
    // Escape in a popover the chip opened hands focus back to the chip.
    press('Escape');
    chip!.focus();
    expect(focusPlacedByPointer(chip!)).toBe(false);
  });

  it('keeps a clicked button clicked when the window goes to the back and comes forward again', () => {
    const [service] = buttons('Service');
    pointerDown();
    service!.focus();
    // A key pressed on it (S drops a Service), then away to another window and back.
    press('s');
    window.dispatchEvent(new FocusEvent('blur'));
    service!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(focusPlacedByPointer(service!)).toBe(true);
  });

  it('does not count a modifier or a chord as moving through controls', () => {
    const [zoomIn, zoomOut] = buttons('Zoom in', 'Zoom out');
    pointerDown();
    zoomIn!.focus();
    press('Alt');
    press('Tab', { altKey: true });
    zoomOut!.focus();
    expect(focusPlacedByPointer(zoomOut!)).toBe(true);
  });
});
