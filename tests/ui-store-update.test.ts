import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUiStore } from '../src/store/uiStore';

/**
 * Phase 6.2/6.3 — the store only ever reflects "an update is ready"; it never
 * decides to reload on its own. `activateUpdate` is a no-op until
 * `registerActivateUpdate` has wired it to the Service Worker's real
 * activate-and-reload function (see `serviceWorker.ts`, called once from
 * `main.tsx`).
 */
describe('uiStore update-ready wiring', () => {
  beforeEach(() => {
    useUiStore.setState({ updateReady: false });
    useUiStore.getState().registerActivateUpdate(null);
  });

  it('defaults to no update ready and a no-op activate', () => {
    expect(useUiStore.getState().updateReady).toBe(false);
    expect(() => useUiStore.getState().activateUpdate()).not.toThrow();
  });

  it('setUpdateReady flips the flag without touching anything else', () => {
    useUiStore.getState().setUpdateReady();
    expect(useUiStore.getState().updateReady).toBe(true);
  });

  it('activateUpdate calls whatever was registered, and only that', () => {
    const activate = vi.fn();
    useUiStore.getState().registerActivateUpdate(activate);
    useUiStore.getState().activateUpdate();
    expect(activate).toHaveBeenCalledOnce();
  });
});

describe('uiStore toasts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const toast of useUiStore.getState().toasts) useUiStore.getState().dismiss(toast.id);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('holds a toast while paused and counts down again once resumed', () => {
    useUiStore.getState().notify('Saved', 'info', { label: 'Undo', run: () => {} });
    vi.advanceTimersByTime(2000);
    useUiStore.getState().pauseToasts();
    vi.advanceTimersByTime(60_000);
    expect(useUiStore.getState().toasts).toHaveLength(1);

    useUiStore.getState().resumeToasts();
    vi.advanceTimersByTime(3900);
    expect(useUiStore.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(200);
    expect(useUiStore.getState().toasts).toHaveLength(0);
  });

  it('never stays paused once the last toast is gone', () => {
    useUiStore.getState().notify('First');
    useUiStore.getState().pauseToasts();
    useUiStore.getState().dismiss(useUiStore.getState().toasts[0]!.id);

    useUiStore.getState().notify('Second');
    vi.advanceTimersByTime(3600);
    expect(useUiStore.getState().toasts).toHaveLength(0);
  });
});
