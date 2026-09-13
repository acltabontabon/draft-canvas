import { beforeEach, describe, expect, it, vi } from 'vitest';

// The real module over a stand-in `localStorage` — `retirePreferences` is exactly the thing other
// tests mock away, so here it must run for real. (Vitest's Node global can shadow jsdom's storage,
// so a test that merely skipped when storage was missing would pass without checking anything.)
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
  clear: () => store.clear(),
});

const { RETIRED_PREFERENCE_KEYS, retirePreferences } = await import('../src/lib/preferences');

describe('retired preferences', () => {
  beforeEach(() => store.clear());

  it('removes every key the old Learn mode and theme pin left behind', () => {
    for (const key of RETIRED_PREFERENCE_KEYS) store.set(`draft-canvas.${key}`, 'x');
    expect(store.size).toBeGreaterThan(8);
    retirePreferences();
    expect(store.size).toBe(0);
  });

  it('leaves current preferences and other apps’ keys alone', () => {
    store.set('draft-canvas.personality', 'sketch');
    store.set('draft-canvas.continuation', 'off');
    store.set('draft-canvas.last-seen-product-release', '1.3.0');
    store.set('hint.service-node', 'unrelated');
    retirePreferences();
    expect(store.get('draft-canvas.personality')).toBe('sketch');
    expect(store.get('draft-canvas.continuation')).toBe('off');
    expect(store.get('draft-canvas.last-seen-product-release')).toBe('1.3.0');
    expect(store.get('hint.service-node')).toBe('unrelated');
  });
});
