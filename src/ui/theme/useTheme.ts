import { createContext, useContext } from 'react';
import { DARK, themeFor, type Theme, type ThemeName } from '../../render/theme/tokens';

/** `system` follows `prefers-color-scheme`, live; the other two are an explicit override. */
export type ThemePreference = 'system' | ThemeName;

export interface ThemeContextValue {
  /** The palette actually on screen, whatever the preference resolved to. */
  name: ThemeName;
  theme: Theme;
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
  /** An explicit override — same as `setPreference(name)`. */
  setTheme: (name: ThemeName) => void;
  /** Pins the opposite of what is on screen. */
  toggle: () => void;
}

export const ThemeContext = createContext<ThemeContextValue>({
  name: 'dark',
  theme: DARK,
  preference: 'system',
  setPreference: () => {},
  setTheme: () => {},
  toggle: () => {},
});

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

/** The resolved palette, for anything that needs literal colours. */
export function useThemeValue(): Theme {
  return useContext(ThemeContext).theme;
}

export { themeFor };
