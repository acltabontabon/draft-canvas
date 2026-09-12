import { createContext, useContext } from 'react';
import { DARK, themeFor, type Theme, type ThemeName } from '../../render/theme/tokens';

export interface ThemeContextValue {
  /** The palette on screen. Always whatever the OS is set to — there is no override. */
  name: ThemeName;
  theme: Theme;
}

export const ThemeContext = createContext<ThemeContextValue>({
  name: 'dark',
  theme: DARK,
});

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

/** The resolved palette, for anything that needs literal colours. */
export function useThemeValue(): Theme {
  return useContext(ThemeContext).theme;
}

export { themeFor };
