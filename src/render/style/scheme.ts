import { ACCENTS, type Accent } from '../../document/types';
import { SCHEME_COLOURS, type DocumentStyle, type StyleScheme } from '../../document/style';
import { contrast, luminance } from '../../lib/colour';
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
  /** What the editor marks on the canvas and beside it (what is chosen, what would be removed): a
   *  graphic that has to be seen, WCAG 1.4.11's 3:1. */
  mark: 3,
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

/** Code is coloured for the theme, not the style: its block keeps the theme's tone of paper. */
function codeHolds(base: Theme, key: (typeof SCHEME_COLOURS)[number], value: string): boolean {
  if (key !== 'codeBg') return true;
  return contrast(base.text, value) >= CONTRAST.text;
}

function mix(a: string, b: string, amount: number): string {
  const channel = (hex: string, at: number) => parseInt(hex.slice(at, at + 2), 16);
  const part = (at: number) => Math.round(channel(a, at) + (channel(b, at) - channel(a, at)) * amount).toString(16).padStart(2, '0');
  return `#${part(1)}${part(3)}${part(5)}`;
}

/**
 * `colour` as it is when it holds `floor` against every one of `grounds`. Otherwise it is taken
 * toward `toward` until it does, and is `toward` itself when a few steps fall short.
 */
function heldOn(colour: string, grounds: readonly string[], toward: string, floor: number): string {
  const holds = (value: string) => grounds.every((ground) => contrast(value, ground) >= floor);
  let out = colour;
  for (let step = 0; step < 8 && !holds(out); step += 1) out = mix(out, toward, 0.3);
  return holds(out) ? out : toward;
}

/**
 * Everything that is drawn beside the canvas colour rather than on it, worked out from it: the
 * panels and bars around the diagram, their hairlines and their faintest words. A style names a
 * canvas, not a toolbar, so these follow the canvas: the whole editor is then one piece of paper,
 * not a coloured page in a grey frame.
 */
function chromeFor(next: Theme): void {
  const light = next.name === 'light';
  next.surface = mix(next.canvas, '#ffffff', light ? 0.42 : 0.035);
  next.surfaceRaised = mix(next.canvas, '#ffffff', light ? 0.68 : 0.07);
  // On a canvas of middling tone a lifted panel comes too near the words on it: there the panels
  // are set a little back from the canvas instead, away from the words.
  if (contrast(next.text, next.surfaceRaised) < CONTRAST.text + 0.3 || contrast(next.textMuted, next.surfaceRaised) < CONTRAST.muted + 0.2) {
    const away = luminance(next.text) > luminance(next.canvas) ? '#000000' : '#ffffff';
    next.surface = mix(next.canvas, away, 0.05);
    next.surfaceRaised = mix(next.canvas, away, 0.1);
  }
  next.border = mix(next.canvas, next.text, 0.15);
  next.borderStrong = mix(next.canvas, next.text, 0.3);
  // Still words: on a canvas of middling tone a fixed share of the way to the words fell under 3:1.
  next.textFaint = heldOn(mix(next.canvas, next.text, 0.62), [next.canvas, next.surface], next.text, CONTRAST.muted);
}

/** `rgba()` of a `#rrggbb` colour: the soft wash a selection is laid in. */
function wash(hex: string, alpha: number): string {
  return `rgba(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)}, ${alpha})`;
}

/**
 * The colours the editor marks things in, what is chosen and what would be removed, on a canvas
 * that is not the one they were chosen for. On a brand's blue the built-in teal was 1.4:1, and a
 * removed shape in a preview could vanish into a red canvas. Each is taken toward the words' side
 * until it can be seen, on the canvas and on a panel. The words already read there, so their side
 * always has room. Where a colour reads as it is, it is kept: every palette and every pack keeps the
 * marks it always had.
 *
 * Twice over, for words and for marks. Where words are written in a colour or on it, it reads as
 * words do: canvas-coloured words are written on the selection (a solid button), and the danger
 * colour is words of its own (a Delete). The ring round what is chosen and a crossed-out removal are
 * graphics, held to a graphic's 3:1 (`selectionMark`, `dangerMark`). Held to words' 4.5:1 as well, on
 * a canvas of middling tone (a brand's blue, a red) only black or white was left, and the ring and
 * what a preview would remove read as the diagram's own words.
 */
function marksFor(next: Theme, base: Theme): void {
  const ink = luminance(next.text) > luminance(next.canvas) ? '#ffffff' : '#000000';
  const grounds = [next.canvas, next.surfaceRaised];
  const selection = heldOn(base.selection, grounds, ink, CONTRAST.text);
  if (selection !== base.selection) {
    next.selection = selection;
    next.selectionSoft = wash(selection, next.name === 'light' ? 0.12 : 0.16);
  }
  next.danger = heldOn(base.danger, grounds, ink, CONTRAST.text);
  next.selectionMark = heldOn(base.selectionMark, grounds, ink, CONTRAST.mark);
  next.dangerMark = heldOn(base.dangerMark, grounds, ink, CONTRAST.mark);
}

/** `base` with a scheme's colours over it. `base` itself when the scheme changes nothing. */
export function schemeTheme(base: Theme, scheme: StyleScheme | undefined): Theme {
  if (!scheme) return base;
  const next: Theme = { ...base };
  let changed = false;
  if (surfaceHolds(base, scheme)) {
    for (const key of SCHEME_COLOURS) {
      const value = scheme[key];
      if (value !== undefined && value !== base[key] && codeHolds(base, key, value)) {
        next[key] = value;
        changed = true;
      }
    }
  }
  if (next.canvas !== base.canvas) {
    chromeFor(next);
    marksFor(next, base);
  }
  // A brand's colour is kept only where it can be seen: on the canvas, and on the panels beside it.
  if (scheme.selection && scheme.selection !== base.selection && contrast(scheme.selection, next.canvas) >= CONTRAST.line && contrast(scheme.selection, next.surfaceRaised) >= CONTRAST.line) {
    next.selection = scheme.selection;
    next.selectionSoft = wash(scheme.selection, next.name === 'light' ? 0.12 : 0.16);
    next.selectionMark = scheme.selection;
    changed = true;
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
