import { ACCENTS, type Accent } from '../../document/types';
import { SCHEME_COLOURS, type DocumentStyle, type StyleScheme } from '../../document/style';
import { contrast } from '../../lib/colour';
import { THEMES, type AccentPalette, type Theme, type ThemeName } from '../theme/tokens';

/**
 * What a colour has to clear to be kept. A style comes from anywhere, and a diagram nobody can read
 * is worse than one in the built-in colours, so a colour that fails falls back, alone and the same
 * way on every device. The floors follow the ones the built-in themes are held to
 * (`tests/theme-contrast.test.ts`), a little looser for lines so a style can be quiet.
 */
export const CONTRAST = {
  /** Words on the canvas. */
  text: 4.5,
  /** Quiet words on the canvas, and a connector's words on their own chip. */
  muted: 3,
  /** A shape's outline, and a plain connector, on the canvas. */
  line: 2.4,
  /** A shape's name on its own fill. */
  label: 4.5,
} as const;

/** The canvas's own colours come as a set: words chosen for one canvas mean nothing on another. */
function surfaceHolds(base: Theme, scheme: StyleScheme): boolean {
  const canvas = scheme.canvas ?? base.canvas;
  return (
    contrast(scheme.text ?? base.text, canvas) >= CONTRAST.text &&
    contrast(scheme.textMuted ?? base.textMuted, canvas) >= CONTRAST.muted &&
    contrast(scheme.edge ?? base.edge, canvas) >= CONTRAST.line &&
    contrast(scheme.edgeText ?? base.edgeText, scheme.edgeLabelBg ?? base.edgeLabelBg) >= CONTRAST.muted
  );
}

function accentHolds(palette: AccentPalette, canvas: string): boolean {
  return (
    contrast(palette.line, canvas) >= CONTRAST.line &&
    contrast(palette.chip, canvas) >= CONTRAST.line &&
    contrast(palette.text, palette.fill) >= CONTRAST.label
  );
}

/** `base` with a scheme's colours over it. `base` itself when the scheme changes nothing. */
export function schemeTheme(base: Theme, scheme: StyleScheme | undefined): Theme {
  if (!scheme) return base;
  const next: Theme = { ...base };
  let changed = false;
  if (surfaceHolds(base, scheme)) {
    for (const key of SCHEME_COLOURS) {
      const value = scheme[key];
      if (value !== undefined && value !== base[key]) {
        next[key] = value;
        changed = true;
      }
    }
  }
  if (scheme.accents) {
    const accents: Record<Accent, AccentPalette> = { ...base.accents };
    for (const accent of ACCENTS) {
      const palette = scheme.accents[accent];
      if (palette && accentHolds(palette, next.canvas)) {
        accents[accent] = palette;
        changed = true;
      }
    }
    next.accents = accents;
  }
  return changed ? next : base;
}

/** The one theme a style is always drawn in, when it has colours for only one. */
export function pinnedTheme(style: DocumentStyle | undefined): ThemeName | undefined {
  const schemes = style?.schemes;
  if (!schemes) return undefined;
  if (schemes.dark && !schemes.light) return 'dark';
  if (schemes.light && !schemes.dark) return 'light';
  return undefined;
}

/** The theme a style is drawn in for each of the device's own settings, light and dark. */
export function styleThemes(style: DocumentStyle | undefined): Record<ThemeName, Theme> {
  const pinned = pinnedTheme(style);
  if (pinned) {
    // One object for both, so nothing downstream sees a change when the device's setting flips.
    const only = schemeTheme(THEMES[pinned], style?.schemes?.[pinned]);
    return { light: only, dark: only };
  }
  return {
    light: schemeTheme(THEMES.light, style?.schemes?.light),
    dark: schemeTheme(THEMES.dark, style?.schemes?.dark),
  };
}
