import { useLayoutEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { applyThemeVariables, themeFor, type ThemeName } from '../../render/theme/tokens';
import { ThemeContext } from './useTheme';

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

/**
 * Draft Canvas follows the OS appearance, live. There is deliberately no override: an editor that
 * quietly disagrees with the rest of your desktop is a papercut, and the choice cost a toolbar
 * button, a settings row and two commands to maintain.
 *
 * The variables are applied in a layout effect so the first React paint is already the right
 * palette. Before React mounts, `tokens.css` follows `prefers-color-scheme` on its own.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const name = useSyncExternalStore(subscribeSystem, systemTheme, () => 'dark' as const);

  useLayoutEffect(() => {
    applyThemeVariables(themeFor(name), document.documentElement);
  }, [name]);

  const value = useMemo(() => ({ name, theme: themeFor(name) }), [name]);

  return <ThemeContext value={value}>{children}</ThemeContext>;
}
