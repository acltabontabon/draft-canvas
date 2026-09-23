import { fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FlowBar } from '../src/ui/Editor/FlowBar';
import { stubPlayback } from './commandStubs';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('FlowBar presentation keys', () => {
  it('steps on ArrowRight, Space and ArrowLeft while presenting', () => {
    const playback = stubPlayback({ active: true });
    render(<FlowBar playback={playback} />);

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    fireEvent.keyDown(window, { key: ' ' });
    fireEvent.keyDown(window, { key: 'ArrowLeft' });

    expect(playback.next).toHaveBeenCalledTimes(2);
    expect(playback.previous).toHaveBeenCalledTimes(1);
  });

  it('stands down while a dialog is open, so the walkthrough does not step on behind it', () => {
    // ⌘E and ? stay live while presenting; the Export and shortcut sheets own the arrows and Space.
    const playback = stubPlayback({ active: true });
    render(<FlowBar playback={playback} />);
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    document.body.append(dialog);

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    fireEvent.keyDown(window, { key: ' ' });
    fireEvent.keyDown(window, { key: 'ArrowLeft' });

    expect(playback.next).not.toHaveBeenCalled();
    expect(playback.previous).not.toHaveBeenCalled();
  });

  /**
   * Stepping and switching flow share one axis on purpose — same arrows, bigger move — so the
   * modifier has to be checked *before* the plain arrows. Until this existed `Shift+→` simply
   * stepped, so this is the guard on a deliberate change of meaning as much as on the new feature.
   */
  it('moves between flows on Shift+arrow, and never also steps', () => {
    const playback = stubPlayback({ active: true });
    render(<FlowBar playback={playback} />);

    fireEvent.keyDown(window, { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(window, { key: 'ArrowLeft', shiftKey: true });

    expect(playback.nextFlow).toHaveBeenCalledTimes(1);
    expect(playback.previousFlow).toHaveBeenCalledTimes(1);
    expect(playback.next).not.toHaveBeenCalled();
    expect(playback.previous).not.toHaveBeenCalled();
  });

  it('stands down entirely while a menu is open, which is what the flow picker is', () => {
    // The picker renders as `role="menu"` precisely so `overlayAboveCanvasIsOpen` already covers
    // it: neither stepping nor switching may happen underneath an open list of flows.
    const playback = stubPlayback({ active: true });
    render(<FlowBar playback={playback} />);
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    document.body.append(menu);

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    fireEvent.keyDown(window, { key: 'ArrowRight', shiftKey: true });
    expect(playback.next).not.toHaveBeenCalled();
    expect(playback.nextFlow).not.toHaveBeenCalled();
  });
});
