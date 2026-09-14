import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { registerSWMock } = vi.hoisted(() => ({ registerSWMock: vi.fn() }));
vi.mock('virtual:pwa-register', () => ({ registerSW: registerSWMock }));

const { initServiceWorker } = await import('../src/lib/serviceWorker');

/**
 * Phase 6.2 — registration must never block, and must never activate an
 * update on its own: `immediate: false` and the returned `activate` function
 * are the only path to `updateSW(true)` (skipWaiting + reload), and that
 * function only ever runs on an explicit user action (see `AboutDialog.tsx`).
 */
describe('initServiceWorker', () => {
  const hadServiceWorker = 'serviceWorker' in navigator;

  beforeEach(() => {
    registerSWMock.mockReset();
  });

  afterEach(() => {
    if (!hadServiceWorker) delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
  });

  it('registers without activating, forwards onNeedRefresh, and saves before activating', async () => {
    Object.defineProperty(navigator, 'serviceWorker', { value: {}, configurable: true });
    const updateSW = vi.fn();
    registerSWMock.mockReturnValue(updateSW);
    const onUpdateReady = vi.fn();
    const order: string[] = [];
    const beforeReload = vi.fn(async () => {
      order.push('saved');
    });
    updateSW.mockImplementation(() => order.push('activated'));

    const activate = initServiceWorker({ onUpdateReady, onUpdatedElsewhere: () => {} }, beforeReload);

    expect(registerSWMock).toHaveBeenCalledWith(
      expect.objectContaining({ immediate: false, onNeedRefresh: expect.any(Function), onNeedReload: expect.any(Function) }),
    );
    expect(onUpdateReady).not.toHaveBeenCalled();

    registerSWMock.mock.calls[0]![0].onNeedRefresh();
    expect(onUpdateReady).toHaveBeenCalledOnce();

    activate?.();
    await vi.waitFor(() => expect(updateSW).toHaveBeenCalledWith(true));
    expect(order).toEqual(['saved', 'activated']);
  });

  it('does not reload over work that failed to save — it hands the choice back instead', async () => {
    Object.defineProperty(navigator, 'serviceWorker', { value: {}, configurable: true });
    const updateSW = vi.fn();
    registerSWMock.mockReturnValue(updateSW);
    let reloadAnyway: (() => void) | undefined;
    const onUnsavedWork = vi.fn((reload: () => void) => {
      reloadAnyway = reload;
    });
    const activate = initServiceWorker(
      { onUpdateReady: () => {}, onUpdatedElsewhere: () => {}, onUnsavedWork },
      async () => false,
    );

    activate?.();
    await vi.waitFor(() => expect(onUnsavedWork).toHaveBeenCalledOnce());
    expect(updateSW).not.toHaveBeenCalled();

    reloadAnyway?.();
    expect(updateSW).toHaveBeenCalledWith(true);
  });

  it('tells a tab that another tab activated the update, instead of reloading it', () => {
    Object.defineProperty(navigator, 'serviceWorker', { value: {}, configurable: true });
    registerSWMock.mockReturnValue(vi.fn());
    const onUpdatedElsewhere = vi.fn();
    initServiceWorker({ onUpdateReady: () => {}, onUpdatedElsewhere });

    registerSWMock.mock.calls[0]![0].onNeedReload();
    expect(onUpdatedElsewhere).toHaveBeenCalledOnce();
  });

  it('is a no-op in a browser without Service Worker support', () => {
    delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
    expect(initServiceWorker({ onUpdateReady: () => {}, onUpdatedElsewhere: () => {} })).toBeNull();
    expect(registerSWMock).not.toHaveBeenCalled();
  });
});
