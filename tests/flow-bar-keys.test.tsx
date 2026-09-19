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
});
