import { useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { applyThemeVariables, clearThemeVariables } from '../render/theme/tokens';
import { ThemeContext, useTheme } from '../theme/useTheme';
import { useDiagramStyle } from './useDiagramStyle';

/**
 * The colours the open diagram is drawn in, for everything on the canvas.
 *
 * Most diagrams have none of their own and this is the app's theme, untouched. A diagram whose
 * style carries colours gets them here and nowhere else: the canvas and what is drawn on it wear
 * the style, while the toolbars and dialogs around it stay the app's. The wrapper takes no box of
 * its own (`display: contents`), it only carries the colour variables the canvas's CSS reads.
 */
export function DiagramTheme({ children }: { children: ReactNode }) {
  const app = useTheme();
  const theme = useDiagramStyle().theme(app.name);
  const own = theme !== app.theme;
  const value = useMemo(() => (own ? { name: theme.name, theme } : app), [own, theme, app]);
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !own) return;
    applyThemeVariables(theme, element);
    return () => clearThemeVariables(element);
  }, [own, theme]);

  return (
    <ThemeContext value={value}>
      <div ref={ref} className="dc-diagram-theme">
        {children}
      </div>
    </ThemeContext>
  );
}
