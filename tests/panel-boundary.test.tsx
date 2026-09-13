import { render, screen, waitFor } from '@testing-library/react';
import { Suspense } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { PanelBoundary } from '../src/ui/common/PanelBoundary';
import { retryableLazy } from '../src/ui/common/retryableLazy';

/** A lazily loaded panel whose chunk fails must fail alone — and load on the next try. */
describe('PanelBoundary + retryableLazy', () => {
  it('contains a failed chunk, then loads it after reset', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    let attempts = 0;
    const chunk = retryableLazy(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('chunk fetch failed');
      return { default: () => <p>Panel</p> };
    });
    const onError = vi.fn(() => chunk.reset());
    const Slot = () => (
      <PanelBoundary onError={onError}>
        <Suspense fallback={null}>
          <chunk.Component />
        </Suspense>
      </PanelBoundary>
    );

    const first = render(
      <div>
        <span>Editor</span>
        <Slot />
      </div>,
    );
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Editor')).toBeTruthy();
    expect(screen.queryByText('Panel')).toBeNull();
    first.unmount();

    render(<Slot />);
    expect(await screen.findByText('Panel')).toBeTruthy();
    expect(attempts).toBe(2);
    quiet.mockRestore();
  });
});
