import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Modal } from '../src/ui/common/Modal';

/**
 * Regression coverage for a focus-steal bug: `Modal`'s keydown-listener effect used to also call
 * `panel.current?.focus()`, and every real caller passes an inline `onClose={() => ...}` that gets
 * a fresh identity on each of the caller's own re-renders — so any unrelated state change in the
 * modal-owning component (e.g. a slider's `onChange`) re-ran the effect and yanked keyboard focus
 * back to the panel, away from whatever the user was actually interacting with inside the modal.
 */
function HostWithChurningOnClose() {
  const [renders, setRenders] = useState(0);
  return (
    <Modal title="Settings" onClose={() => void 0}>
      <input aria-label="Example field" onChange={() => setRenders((n) => n + 1)} />
      <span data-testid="render-count">{renders}</span>
    </Modal>
  );
}

describe('Modal focus handling', () => {
  it('focuses the panel once on mount, not on every re-render', () => {
    render(
      <Modal title="Settings" onClose={() => void 0}>
        <input aria-label="Example field" />
      </Modal>,
    );
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
  });

  it('keeps focus on an inner field across a re-render that changes onClose identity', () => {
    render(<HostWithChurningOnClose />);
    const field = screen.getByLabelText('Example field');
    field.focus();
    expect(document.activeElement).toBe(field);

    // Typing fires onChange, which re-renders the host with a brand-new inline `onClose` —
    // exactly the case that used to steal focus back to the outer panel.
    fireEvent.change(field, { target: { value: 'x' } });
    expect(screen.getByTestId('render-count').textContent).toBe('1');
    expect(document.activeElement).toBe(field);
  });

  it('leaves an autoFocus field focused instead of pulling focus back to the panel', () => {
    render(
      <Modal title="Rename" onClose={() => void 0}>
        <input aria-label="Title" autoFocus />
      </Modal>,
    );
    expect(document.activeElement).toBe(screen.getByLabelText('Title'));
  });

  it('Escape in a modal opened from inside another closes only the inner one', () => {
    const outerClose = vi.fn();
    const innerClose = vi.fn();
    render(
      <Modal title="Export" onClose={outerClose}>
        <Modal title="Passphrase" onClose={innerClose}>
          <input aria-label="Passphrase" />
        </Modal>
      </Modal>,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(innerClose).toHaveBeenCalledOnce();
    expect(outerClose).not.toHaveBeenCalled();
  });
});
