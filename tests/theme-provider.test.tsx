import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.mock` of `lib/preferences`, so a pinned theme in one test can't leak into the next through
// the real `localStorage`.
const prefs = new Map<string, string>();
vi.mock('../src/lib/preferences', () => ({
  readPreference: (key: string) => prefs.get(key) ?? null,
  writePreference: (key: string, value: string) => void prefs.set(key, value),
  removePreference: (key: string) => void prefs.delete(key),
}));

const { ThemeProvider } = await import('../src/ui/theme/ThemeProvider');
const { useTheme } = await import('../src/ui/theme/useTheme');

/** A `prefers-color-scheme: dark` query whose answer the test can flip, firing `change`. */
function fakeSystem(initiallyDark: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: initiallyDark,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  };
  vi.stubGlobal('matchMedia', () => query);
  return {
    set(dark: boolean) {
      query.matches = dark;
      for (const listener of listeners) listener();
    },
  };
}

function Probe() {
  return <span data-testid="theme">{useTheme().name}</span>;
}

const mount = () =>
  render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  );

beforeEach(() => {
  prefs.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ThemeProvider', () => {
  it('follows the system appearance, and keeps following it while open', () => {
    const system = fakeSystem(false);
    mount();
    expect(screen.getByTestId('theme')).toHaveTextContent('light');
    expect(document.documentElement.dataset.theme).toBe('light');

    act(() => system.set(true));
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('never writes a preference — the OS is the only source', () => {
    fakeSystem(true);
    mount();
    expect(prefs.size).toBe(0);
  });

  it('ignores a theme an older build pinned, and clears it', () => {
    fakeSystem(true);
    prefs.set('theme-override', 'light');
    mount();
    // The pin loses to the OS rather than surviving as an invisible override.
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
    expect(prefs.has('theme-override')).toBe(false);
  });

  it('drops the value older builds wrote on every first launch, so it can never pin anything', () => {
    fakeSystem(false);
    prefs.set('theme', 'dark');
    mount();
    expect(screen.getByTestId('theme')).toHaveTextContent('light');
    expect(prefs.has('theme')).toBe(false);
  });
});
