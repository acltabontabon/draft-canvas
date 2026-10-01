import type { ThemeName } from '../../render/theme/tokens';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * The palette the OS asks for right now — what `ThemeProvider` follows, readable outside React for
 * a command that renders an image the way the screen shows it. Dark when nothing can be asked, the
 * same answer `tokens.css` paints before React mounts.
 */
export function systemTheme(): ThemeName {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'dark';
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}
