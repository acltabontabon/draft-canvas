import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Node's own experimental `globalThis.localStorage` shadows jsdom's
// implementation in this environment (unrelated to app code — real browsers
// always provide it) — a tiny in-memory fake stands in for `lib/preferences.ts`
// so this test exercises `PersonalityProvider`'s actual read/fallback/persist
// logic without depending on that environment quirk.
const store = new Map<string, string>();
vi.mock('../src/lib/preferences', () => ({
  readPreference: (key: string) => store.get(key) ?? null,
  writePreference: (key: string, value: string) => void store.set(key, value),
}));

const { PersonalityProvider } = await import('../src/ui/personality/PersonalityProvider');
const { usePersonality } = await import('../src/ui/personality/usePersonality');

function Probe({ onReady }: { onReady: (api: ReturnType<typeof usePersonality>) => void }) {
  const api = usePersonality();
  onReady(api);
  return null;
}

beforeEach(() => {
  store.clear();
});

/**
 * Phase 5.2 — a global device preference, mirroring `ThemeProvider`'s own
 * pattern: read on mount (falling back to `'clean'` for anything missing or
 * invalid), persisted via `preferences.ts` on every change.
 */
describe('PersonalityProvider', () => {
  it('defaults to "clean" when nothing is stored', () => {
    let latest: ReturnType<typeof usePersonality> | undefined;
    render(
      <PersonalityProvider>
        <Probe onReady={(api) => (latest = api)} />
      </PersonalityProvider>,
    );
    expect(latest!.preset).toBe('clean');
  });

  it('falls back to "clean" for a corrupted stored value', () => {
    store.set('personality', 'not-a-real-preset');
    let latest: ReturnType<typeof usePersonality> | undefined;
    render(
      <PersonalityProvider>
        <Probe onReady={(api) => (latest = api)} />
      </PersonalityProvider>,
    );
    expect(latest!.preset).toBe('clean');
  });

  it('reads a previously-stored preset on mount', () => {
    store.set('personality', 'sketch');
    let latest: ReturnType<typeof usePersonality> | undefined;
    render(
      <PersonalityProvider>
        <Probe onReady={(api) => (latest = api)} />
      </PersonalityProvider>,
    );
    expect(latest!.preset).toBe('sketch');
  });

  it('persists a change via setPreset', () => {
    let latest: ReturnType<typeof usePersonality> | undefined;
    render(
      <PersonalityProvider>
        <Probe onReady={(api) => (latest = api)} />
      </PersonalityProvider>,
    );
    act(() => latest!.setPreset('draft'));
    expect(store.get('personality')).toBe('draft');
  });
});
