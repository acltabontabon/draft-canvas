import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Same in-memory fake `tests/personality-preference.test.tsx` uses — see its own comment for why.
const store = new Map<string, string>();
vi.mock('../src/lib/preferences', () => ({
  readPreference: (key: string) => store.get(key) ?? null,
  writePreference: (key: string, value: string) => void store.set(key, value),
}));

const { HintsProvider } = await import('../src/learning/HintsProvider');
const { useHints } = await import('../src/learning/useHints');

function Probe({ onReady }: { onReady: (api: ReturnType<typeof useHints>) => void }) {
  const api = useHints();
  onReady(api);
  return null;
}

beforeEach(() => {
  store.clear();
});

/**
 * Phase 7.1/7.2 — a global device preference, mirroring `PersonalityProvider`'s own pattern: read
 * every catalog id on mount, persisted the moment a hint retires (dismissal or "learned").
 */
describe('HintsProvider', () => {
  it('has nothing retired by default', () => {
    let latest: ReturnType<typeof useHints> | undefined;
    render(
      <HintsProvider>
        <Probe onReady={(api) => (latest = api)} />
      </HintsProvider>,
    );
    expect(latest!.isRetired('service-node')).toBe(false);
    expect(latest!.isRetired('attachment-slot')).toBe(false);
    expect(latest!.isRetired('connector-selected')).toBe(false);
    expect(latest!.isRetired('connector-attachment-slot')).toBe(false);
  });

  it('reads a previously-retired hint on mount', () => {
    store.set('hint.connector-selected', '1');
    let latest: ReturnType<typeof useHints> | undefined;
    render(
      <HintsProvider>
        <Probe onReady={(api) => (latest = api)} />
      </HintsProvider>,
    );
    expect(latest!.isRetired('connector-selected')).toBe(true);
    expect(latest!.isRetired('service-node')).toBe(false);
  });

  it('persists and reflects a retirement via retire()', () => {
    let latest: ReturnType<typeof useHints> | undefined;
    render(
      <HintsProvider>
        <Probe onReady={(api) => (latest = api)} />
      </HintsProvider>,
    );
    act(() => latest!.retire('service-node'));
    expect(store.get('hint.service-node')).toBe('1');
    expect(latest!.isRetired('service-node')).toBe(true);
    // Retiring one hint never touches another.
    expect(latest!.isRetired('attachment-slot')).toBe(false);
  });
});
