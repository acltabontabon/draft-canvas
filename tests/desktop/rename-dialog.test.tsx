import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopError } from '../../src/desktop/api';
import { RenameFileDialog } from '../../src/desktop/ui/RenameFileDialog';

/** "Rename file…": one rename per submit, and the dialog stays until that rename has answered. */

afterEach(cleanup);

function open(onSubmit: (stem: string) => Promise<unknown>) {
  const onClose = vi.fn();
  render(<RenameFileDialog currentName="checkout" onSubmit={onSubmit} onClose={onClose} />);
  return { onClose, input: screen.getByRole('textbox') };
}

describe('Rename File', () => {
  it('renames once when Enter is pressed twice in the same moment', async () => {
    let finish: () => void = () => {};
    const onSubmit = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const { onClose, input } = open(onSubmit);
    fireEvent.change(input, { target: { value: 'orders' } });

    // Both land before React has rendered `busy`.
    act(() => {
      fireEvent.keyDown(input, { key: 'Enter' });
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('orders');

    await act(async () => finish());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stays open on Escape while the rename is under way, so a failure can be shown', async () => {
    let fail: (error: Error) => void = () => {};
    const onSubmit = vi.fn(() => new Promise<void>((_, reject) => (fail = reject)));
    const { onClose, input } = open(onSubmit);
    fireEvent.change(input, { target: { value: 'orders' } });
    act(() => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });

    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => fail(new DesktopError('PermissionDenied', 'A file with that name is already there.')));
    expect(screen.getByRole('alert').textContent).toContain('already there');
    // Answered: Escape closes it again, and another try is allowed.
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
