import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Toasts } from '../src/ui/common/Toasts';
import { useUiStore } from '../src/store/uiStore';

describe('Toasts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const toast of useUiStore.getState().toasts) useUiStore.getState().dismiss(toast.id);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('dismissing a focused toast moves focus to the next one, and a toast left unfocused still counts down', () => {
    render(<Toasts />);
    act(() => {
      useUiStore.getState().notify('First');
      useUiStore.getState().notify('Second');
    });
    const [first, second] = screen.getAllByRole('button', { name: 'Dismiss' });
    act(() => first!.focus());
    act(() => fireEvent.click(first!));
    expect(document.activeElement).toBe(second);

  });

  it('a toast removed while it held focus (no blur fires) does not leave the others paused', () => {
    render(<Toasts />);
    act(() => {
      useUiStore.getState().notify('First');
      useUiStore.getState().notify('Second');
    });
    act(() => screen.getAllByRole('button', { name: 'Dismiss' })[0]!.focus());
    const [first] = useUiStore.getState().toasts;
    act(() => useUiStore.getState().dismiss(first!.id));
    act(() => vi.advanceTimersByTime(3600));
    expect(useUiStore.getState().toasts).toHaveLength(0);
  });
});
