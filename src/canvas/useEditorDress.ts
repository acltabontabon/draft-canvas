import { useLayoutEffect, type RefObject } from 'react';
import { applyThemeVariables, clearThemeVariables } from '../render/theme/tokens';
import { useTheme } from '../theme/useTheme';
import { useDiagramStyle } from './useDiagramStyle';

/**
 * The whole editor in the open diagram's colours: its bars, its panels and the chips that float on
 * the canvas, not the canvas alone.
 *
 * A style that names a canvas colour is a piece of paper, and paper in a grey frame reads as a
 * picture of a diagram, not a diagram. So the editor's root carries the same variables the canvas
 * does (`DiagramTheme`), and everything inside it is drawn from them. Dialogs and menus that open
 * over the editor are not inside it and stay the app's, as does Home.
 */
export function useEditorDress(root: RefObject<HTMLElement | null>): void {
  const app = useTheme();
  const theme = useDiagramStyle().theme(app.name);
  const own = theme !== app.theme;
  useLayoutEffect(() => {
    const element = root.current;
    if (!element || !own) return;
    applyThemeVariables(theme, element);
    return () => clearThemeVariables(element);
  }, [root, own, theme]);
}
