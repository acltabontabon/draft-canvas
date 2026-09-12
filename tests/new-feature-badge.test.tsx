import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Same in-memory fake `tests/personality-preference.test.tsx` uses — see its own comment for why.
const store = new Map<string, string>();
vi.mock('../src/lib/preferences', () => ({
  readPreference: (key: string) => store.get(key) ?? null,
  writePreference: (key: string, value: string) => void store.set(key, value),
}));

const { useIsNewFeature } = await import('../src/learning/useNewFeature');
const { PRODUCT } = await import('../src/product');

function Probe({ onReady }: { onReady: (api: ReturnType<typeof useIsNewFeature>) => void }) {
  const api = useIsNewFeature('learn-mode');
  onReady(api);
  return null;
}

beforeEach(() => {
  store.clear();
});

/**
 * Phase 7.3 — nothing looks "new" on a fresh install (no baseline to compare against); a
 * returning device whose last-seen version predates the catalog entry's fixed `sinceVersion`
 * (see `newFeatures.ts`) sees the badge until it retires.
 */
describe('useIsNewFeature', () => {
  it('is never new on a brand-new install (no stored version at all)', () => {
    let latest: ReturnType<typeof useIsNewFeature> | undefined;
    render(<Probe onReady={(api) => (latest = api)} />);
    expect(latest!.isNew).toBe(false);
  });

  it('is new for a device returning from an older version', () => {
    store.set('last-seen-version', '0.0.1-alpha.0');
    let latest: ReturnType<typeof useIsNewFeature> | undefined;
    render(<Probe onReady={(api) => (latest = api)} />);
    expect(latest!.isNew).toBe(true);
  });

  it('is not new for a device already on the current version', () => {
    store.set('last-seen-version', PRODUCT.version);
    let latest: ReturnType<typeof useIsNewFeature> | undefined;
    render(<Probe onReady={(api) => (latest = api)} />);
    expect(latest!.isNew).toBe(false);
  });

  it('is not new for a device returning from a real past release, even a much older one', () => {
    // Regression: sinceVersion must be a fixed historical string, not the live PRODUCT.version —
    // otherwise every entry looks newer than any stored baseline on every single release.
    store.set('last-seen-version', '1.0.0');
    let latest: ReturnType<typeof useIsNewFeature> | undefined;
    render(<Probe onReady={(api) => (latest = api)} />);
    expect(latest!.isNew).toBe(false);
  });

  it('retires and persists across mounts', () => {
    store.set('last-seen-version', '0.0.1-alpha.0');
    let latest: ReturnType<typeof useIsNewFeature> | undefined;
    render(<Probe onReady={(api) => (latest = api)} />);
    expect(latest!.isNew).toBe(true);
    act(() => latest!.retire());
    expect(latest!.isNew).toBe(false);
    expect(store.get('feature-seen.learn-mode')).toBe('1');
  });

  it('refreshes the stored version on mount', () => {
    store.set('last-seen-version', '0.0.1-alpha.0');
    render(<Probe onReady={() => {}} />);
    expect(store.get('last-seen-version')).toBe(PRODUCT.version);
  });
});
