import { createContext, useContext } from 'react';
import { DARK, themeFor, type Theme, type ThemeName } from '../../render/theme/tokens';

export interface ThemeContextValue {
  name: ThemeName;
  theme: Theme;
  setTheme: (name: ThemeName) => void;
  toggle: () => void;
}

export const ThemeContext = createContext<ThemeContextValue>({
  name: 'dark',
  theme: DARK,
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
