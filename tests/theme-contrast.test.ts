import { describe, expect, it } from 'vitest';
import { DARK, LIGHT, type Theme } from '../src/render/theme/tokens';

/**
 * WCAG 2.1 contrast for the outlines a diagram is made of.
 *
 * A shape with no accent is drawn in `accents.neutral.line`, and a connector in `edge`; both have to
 * be told apart from the canvas (and from a surface, since shapes sit on boundaries and panels) by
 * someone with low vision. SC 1.4.11 (non-text contrast) puts that floor at 3:1 for a graphical
 * object's outline. Computed from the hex tokens here, so a palette retune that quietens the neutral
 * outline below the floor fails this test instead of a user's eyes.
 */

function channel(hex: string, offset: number): number {
  const c = parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance of a `#rrggbb` colour, per WCAG 2.1. */
export function relativeLuminance(hex: string): number {
  const h = hex.replace('#', '');
  expect(h).toMatch(/^[0-9a-f]{6}$/i);
  return 0.2126 * channel(h, 0) + 0.7152 * channel(h, 2) + 0.0722 * channel(h, 4);
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const OUTLINE_FLOOR = 3;

describe.each<[string, Theme]>([
  ['light', LIGHT],
  ['dark', DARK],
])('%s theme outlines', (_name, theme) => {
  it('draws a neutral shape outline at 3:1 or better against the canvas and a surface', () => {
    expect(contrastRatio(theme.accents.neutral.line, theme.canvas)).toBeGreaterThanOrEqual(OUTLINE_FLOOR);
    expect(contrastRatio(theme.accents.neutral.line, theme.surface)).toBeGreaterThanOrEqual(OUTLINE_FLOOR);
  });

  it('draws a connector at 3:1 or better against the canvas and a surface', () => {
    expect(contrastRatio(theme.edge, theme.canvas)).toBeGreaterThanOrEqual(OUTLINE_FLOOR);
    expect(contrastRatio(theme.edge, theme.surface)).toBeGreaterThanOrEqual(OUTLINE_FLOOR);
  });

  it('keeps the quiet palette: the neutral outline stays well short of text contrast', () => {
    // The point of the retune was a floor, not a black box: an outline that reaches body-text
    // contrast (4.5:1) has stopped being quiet.
    expect(contrastRatio(theme.accents.neutral.line, theme.canvas)).toBeLessThan(4.5);
  });

  it('every accent outline clears the same floor against the canvas', () => {
    for (const [accent, palette] of Object.entries(theme.accents)) {
      expect(contrastRatio(palette.line, theme.canvas), accent).toBeGreaterThanOrEqual(OUTLINE_FLOOR);
    }
  });
});

describe('contrastRatio', () => {
  it('matches the WCAG reference points', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    expect(contrastRatio('#767676', '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });
});
