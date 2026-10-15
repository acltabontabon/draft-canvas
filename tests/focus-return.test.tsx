import { render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Modal } from '../src/ui/common/Modal';
import { handOffFocus, useFocusReturn } from '../src/ui/common/useFocusReturn';

function Dialog() {
  useFocusReturn(true);
  return <button type="button">inside</button>;
}

afterEach(() => {
  handOffFocus(null, null);
  document.body.innerHTML = '';
});

describe('useFocusReturn', () => {
  function openerAndPalette() {
    const opener = document.createElement('button');
    const paletteInput = document.createElement('input');
    document.body.append(opener, paletteInput);
    opener.focus();
    // The palette opened over the opener and took focus into its input.
    paletteInput.focus();
    return { opener, paletteInput };
  }

  it('returns focus to whatever opened the palette when a dialog opened through it closes', () => {
    const { opener, paletteInput } = openerAndPalette();
    handOffFocus(paletteInput, opener);

    const { unmount } = render(<Dialog />);
    // The palette is gone by the time the dialog closes.
    paletteInput.remove();
    unmount();

    expect(document.activeElement).toBe(opener);
  });

  it('would drop focus to the page without the handoff, since the palette input is gone', () => {
    const { paletteInput } = openerAndPalette();

    const { unmount } = render(<Dialog />);
    paletteInput.remove();
    unmount();

    expect(document.activeElement).toBe(document.body);
  });

  it('ignores a handoff whose surface is not the one holding focus', () => {
    const { opener, paletteInput } = openerAndPalette();
    handOffFocus(paletteInput, opener);
    const other = document.createElement('button');
    document.body.append(other);
    other.focus();

    const { unmount } = render(<Dialog />);
    unmount();

    expect(document.activeElement).toBe(other);
  });
});

describe('Modal', () => {
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

  it('returns focus to whatever opened the palette when a dialog run from it closes', async () => {
    const opener = document.createElement('button');
    const paletteInput = document.createElement('input');
    document.body.append(opener, paletteInput);
    paletteInput.focus();
    handOffFocus(paletteInput, opener);

    // The palette closes in the same render the command's dialog opens.
    const { unmount } = render(<Modal title="Export" onClose={() => {}}>body</Modal>);
    paletteInput.remove();
    unmount();
    await frame();

    expect(document.activeElement).toBe(opener);
  });

  it('returns focus to the control that opened it', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();

    const { unmount } = render(<Modal title="Settings" onClose={() => {}}>body</Modal>);
    expect(document.activeElement).not.toBe(opener);
    unmount();
    await frame();

    expect(document.activeElement).toBe(opener);
  });
});
