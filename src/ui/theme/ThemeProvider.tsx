import { useCallback, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { applyThemeVariables, themeFor, type ThemeName } from '../../render/theme/tokens';
import { readPreference, removePreference, writePreference } from '../../lib/preferences';
import { ThemeContext, type ThemePreference } from './useTheme';

/** Only ever written by an explicit choice — the absence of it *is* "follow the system". */
const OVERRIDE_KEY = 'theme-override';
/**
 * What earlier builds wrote on every first launch, chosen or not — so its value can't be told
 * apart from a real choice. Never read; removed once so everyone starts out following the OS.
 */
const LEGACY_KEY = 'theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

function mediaQuery(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(DARK_QUERY)
    : null;
}

function subscribeSystem(onChange: () => void): () => void {
  const query = mediaQuery();
  if (!query) return () => {};
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/** Dark when nothing can be asked — the palette `tokens.css` paints before React mounts. */
function systemTheme(): ThemeName {
  const query = mediaQuery();
  if (!query) return 'dark';
  return query.matches ? 'dark' : 'light';
}

function initialPreference(): ThemePreference {
  const stored = readPreference(OVERRIDE_KEY);
  return stored === 'dark' || stored === 'light' ? stored : 'system';
}

/**
 * Draft Canvas follows the OS appearance, live, unless someone explicitly picks a side (the
 * editor toolbar, ⌘K, or Canvas settings). The preference is one of the few things kept in
 * `localStorage`: read synchronously on boot, and the variables applied in a layout effect, so the
 * first React paint is already the right palette. Before React mounts, `tokens.css` follows
 * `prefers-color-scheme` on its own.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<ThemePreference>(initialPreference);
  const system = useSyncExternalStore(subscribeSystem, systemTheme, () => 'dark' as const);
  const name: ThemeName = preference === 'system' ? system : preference;

  useLayoutEffect(() => {
    applyThemeVariables(themeFor(name), document.documentElement);
  }, [name]);

  useEffect(() => {
    removePreference(LEGACY_KEY);
  }, []);

  useEffect(() => {
    if (preference === 'system') removePreference(OVERRIDE_KEY);
    else writePreference(OVERRIDE_KEY, preference);
  }, [preference]);

  const setTheme = useCallback((next: ThemeName) => setPreference(next), []);
  // Flips what is on screen, whichever way it got there — so from "system" it pins the opposite.
  const toggle = useCallback(() => setPreference(name === 'dark' ? 'light' : 'dark'), [name]);

  const value = useMemo(
    () => ({ name, theme: themeFor(name), preference, setPreference, setTheme, toggle }),
    [name, preference, setTheme, toggle],
  );

  return <ThemeContext value={value}>{children}</ThemeContext>;
}
