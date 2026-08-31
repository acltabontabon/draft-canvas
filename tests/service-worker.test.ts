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

  it('registers without activating, and forwards onNeedRefresh', () => {
    Object.defineProperty(navigator, 'serviceWorker', { value: {}, configurable: true });
    const updateSW = vi.fn();
    registerSWMock.mockReturnValue(updateSW);
    const onUpdateReady = vi.fn();

    const activate = initServiceWorker(onUpdateReady);

    expect(registerSWMock).toHaveBeenCalledWith(
      expect.objectContaining({ immediate: false, onNeedRefresh: expect.any(Function) }),
    );
    expect(onUpdateReady).not.toHaveBeenCalled();

    registerSWMock.mock.calls[0][0].onNeedRefresh();
    expect(onUpdateReady).toHaveBeenCalledOnce();

    activate?.();
    expect(updateSW).toHaveBeenCalledWith(true);
  });

  it('is a no-op in a browser without Service Worker support', () => {
    delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
    expect(initServiceWorker(() => {})).toBeNull();
    expect(registerSWMock).not.toHaveBeenCalled();
  });
});
