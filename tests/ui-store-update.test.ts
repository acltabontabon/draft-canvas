import { beforeEach, describe, expect, it, vi } from 'vitest';
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
