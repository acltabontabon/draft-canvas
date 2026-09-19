import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SecureExportPrompt } from '../src/ui/Editor/SecureExportPrompt';

describe('SecureExportPrompt while encrypting', () => {
  it('closes on Escape and the X when idle', () => {
    const onCancel = vi.fn();
    render(<SecureExportPrompt busy={false} onCancel={onCancel} onConfirm={() => {}} />);

    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it('ignores Escape and the X once the file is being encrypted — it would still download', () => {
    const onCancel = vi.fn();
    render(<SecureExportPrompt busy onCancel={onCancel} onConfirm={() => {}} />);

    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(onCancel).not.toHaveBeenCalled();
  });
});
