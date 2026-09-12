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

describe('HintsProvider', () => {
  it('has nothing dismissed by default, and ignores retirements persisted by older builds', () => {
    store.set('hint.connector-selected', '1');
    let latest: ReturnType<typeof useHints> | undefined;
    render(
      <HintsProvider>
        <Probe onReady={(api) => (latest = api)} />
      </HintsProvider>,
    );
    expect(latest!.isDismissedThisSession('connector-selected')).toBe(false);
    expect(latest!.isDismissedThisSession('service-node')).toBe(false);
  });

  it('dismisses a hint for the session the moment it retires, without persisting or touching others', () => {
    let latest: ReturnType<typeof useHints> | undefined;
    render(
      <HintsProvider>
        <Probe onReady={(api) => (latest = api)} />
      </HintsProvider>,
    );
    act(() => latest!.retire('attachment-slot'));
    expect(latest!.isDismissedThisSession('attachment-slot')).toBe(true);
    expect(latest!.isDismissedThisSession('service-node')).toBe(false);
    expect(store.size).toBe(0);
  });
});
