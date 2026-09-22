/**
 * The tray's action icons, as SVG path data on a 24-unit square: the app's own line, not the
 * system's glyphs. The native menu draws them onto a canvas (`trayArt.ts`); the panel draws them as SVG.
 */
export type TrayGlyph = 'quickDraft' | 'newCanvas' | 'open' | 'openProject';

export const TRAY_GLYPHS: Record<TrayGlyph, { lines: string[]; faint?: string[] }> = {
  // The app's mark: two boxes and a connector — a diagram, started.
  quickDraft: {
    lines: [
      'M4.5 5.5h8a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 3 10V7a1.5 1.5 0 0 1 1.5-1.5Z',
      'M11.5 13.5h8a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1-1.5 1.5h-8a1.5 1.5 0 0 1-1.5-1.5v-3a1.5 1.5 0 0 1 1.5-1.5Z',
      'M7.5 11.5v4.5h2.5',
    ],
  },
  // A sheet with a fold, and the plus of a new one.
  newCanvas: {
    lines: ['M6.5 3h7l4.5 4.5v12a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5 19.5v-15A1.5 1.5 0 0 1 6.5 3Z', 'M13.5 3v4.5H18', 'M11.5 11v6M8.5 14h6'],
  },
  // A sheet with a small diagram on it: a file you already have.
  open: {
    lines: ['M6.5 3h7l4.5 4.5v12a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5 19.5v-15A1.5 1.5 0 0 1 6.5 3Z', 'M13.5 3v4.5H18'],
    faint: ['M8.5 11h3v2.5h-3ZM11.5 15.5h3V18h-3Z', 'M10 13.5v3h1.5'],
  },
  // A folder holding diagrams: a project is just a folder.
  openProject: {
    lines: ['M3 7.5A1.5 1.5 0 0 1 4.5 6h4.5l2 2h8.5a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5Z'],
    faint: ['M7.5 12h3.5v2.5H7.5ZM13 15h3.5v2.5H13Z', 'M9.25 14.5v1.75H13'],
  },
};
