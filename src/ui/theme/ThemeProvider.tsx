import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { applyThemeVariables, themeFor, type ThemeName } from '../../render/theme/tokens';
import { readPreference, writePreference } from '../../lib/preferences';
import { ThemeContext } from './useTheme';

const STORAGE_KEY = 'theme';

function initialTheme(): ThemeName {
  const stored = readPreference(STORAGE_KEY);
  if (stored === 'dark' || stored === 'light') return stored;
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return 'dark';
}

/**
 * Theme is one of the few things kept in `localStorage`: it is a two-character
 * preference, not document content, and reading it synchronously on boot avoids
 * a flash of the wrong palette.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [name, setName] = useState<ThemeName>(initialTheme);

  useEffect(() => {
    applyThemeVariables(themeFor(name), document.documentElement);
    writePreference(STORAGE_KEY, name);
  }, [name]);

  const setTheme = useCallback((next: ThemeName) => setName(next), []);
  const toggle = useCallback(() => setName((current) => (current === 'dark' ? 'light' : 'dark')), []);

  const value = useMemo(
    () => ({ name, theme: themeFor(name), setTheme, toggle }),
    [name, setTheme, toggle],
  );

  return <ThemeContext value={value}>{children}</ThemeContext>;
}
