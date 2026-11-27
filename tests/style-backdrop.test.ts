import { describe, expect, it } from 'vitest';
import { createDocument, createNode } from '../src/document/factory';
import { addNodes } from '../src/document/operations';
import { normalizeAsset, normalizeStyle, type DocumentStyle } from '../src/document/style';
import { ACCENTS } from '../src/document/types';
import { backdropTile } from '../src/render/style/backdrop';
import { BUILTIN_BACKDROPS, isBuiltinBackdrop } from '../src/render/style/backdrops';
import { contrast } from '../src/lib/colour';
import { brandOf, CANVAS_SWATCHES, paletteOf, schemesForCanvas, withBrand } from '../src/render/style/palettes';
import { resolveStyle } from '../src/render/style/resolve';
import { CONTRAST, styleThemes } from '../src/render/style/scheme';
import { renderDocumentSvg } from '../src/render/svg/document';

const tile = BUILTIN_BACKDROPS[0]!.asset;
const withBackdrop = (extra: Record<string, unknown> = {}): unknown => ({ v: 1, hand: { base: 'clean' }, backdrop: { art: tile.id, ...extra }, assets: [tile] });

describe('a style’s backdrop', () => {
  it('comes with drawings that are each exactly the stored form', () => {
    for (const { asset } of BUILTIN_BACKDROPS) {
      expect(normalizeAsset(asset), asset.id).toEqual(asset);
      expect(isBuiltinBackdrop(asset.id)).toBe(true);
    }
    expect(new Set(BUILTIN_BACKDROPS.map((entry) => entry.asset.id)).size).toBe(BUILTIN_BACKDROPS.length);
  });

  it('is kept with its drawing, and says only what is not the default', () => {
    const { style, repairs } = normalizeStyle(withBackdrop({ strength: 'regular', scale: 'large', nonsense: 1 }));
    expect(repairs).toEqual([]);
    expect(style?.backdrop).toEqual({ art: tile.id, scale: 'large' });
    expect(style?.assets).toEqual([tile]);
  });

  it('is dropped when it names a drawing the style does not hold', () => {
    const { style } = normalizeStyle({ v: 1, hand: { base: 'clean' }, backdrop: { art: 'amissing00' }, assets: [tile] });
    expect(style?.backdrop).toBeUndefined();
    // And the drawing nothing uses goes with it.
    expect(style?.assets).toBeUndefined();
  });

  it('resolves to one tile per theme, the same object every time', () => {
    const resolved = resolveStyle(normalizeStyle(withBackdrop({ scale: 'small', strength: 'strong' })).style);
    const light = backdropTile(resolved, 'light');
    expect(light).not.toBeNull();
    expect(backdropTile(resolved, 'light')).toBe(light);
    expect(light!.width).toBeLessThan(tile.w);
    expect(light!.uri.startsWith('url("data:image/svg+xml,')).toBe(true);
    // Painted by role: the same drawing is another colour on a dark canvas.
    expect(backdropTile(resolved, 'dark')!.uri).not.toBe(light!.uri);
    expect(backdropTile(resolveStyle({ v: 1, hand: { base: 'clean' } }), 'light')).toBeNull();
  });

  it('is drawn fainter or stronger than its drawing, at each of the three strengths', () => {
    for (const { id, asset } of BUILTIN_BACKDROPS) {
      const tileAt = (strength: string) => backdropTile(resolveStyle(normalizeStyle({ v: 1, hand: { base: 'clean' }, backdrop: { art: asset.id, strength }, assets: [asset] }).style), 'light')!;
      const [faint, regular, strong] = [tileAt('faint'), tileAt('regular'), tileAt('strong')];
      // Strong once drew exactly Regular: its multiplier was clamped where the whole tile is laid.
      expect(new Set([faint.uri, regular.uri, strong.uri]).size, id).toBe(3);
      const own = asset.paths.map((path) => path.o ?? 1);
      const opacities = (tile: typeof faint) => tile.shapes.map((shape) => (shape.t === 'path' ? shape.opacity ?? 1 : NaN));
      expect([regular.opacity, opacities(regular)], id).toEqual([1, own]);
      expect([faint.opacity, opacities(faint)], id).toEqual([0.5, own]);
      // Stronger is each part laid heavier, never past solid.
      expect([strong.opacity, opacities(strong)], id).toEqual([1, own.map((o) => Math.min(1, Math.round(o * 1.7 * 1000) / 1000))]);
    }
  });

  it('is drawn behind an export, and left out of a transparent one', () => {
    const style = normalizeStyle(withBackdrop()).style as DocumentStyle;
    const document = { ...addNodes(createDocument('Backdrop'), [createNode({ id: 'a', type: 'service', x: 0, y: 0, text: 'Orders' })]), style };
    const drawn = renderDocumentSvg(document, { theme: 'light' }).svg;
    expect(drawn).toContain('<pattern');
    expect(drawn).toMatch(/fill="url\(#[^"]*dc-backdrop[^"]*\)"/);
    expect(renderDocumentSvg(document, { theme: 'light', transparent: true }).svg).not.toContain('<pattern');
    expect(renderDocumentSvg(document, { theme: 'light', includeBackground: false }).svg).not.toContain('<pattern');
  });
});

describe('a canvas colour of one’s own', () => {
  const brand = ['#ffffff', '#000000', '#2563eb', '#f59e0b', '#e11d48', '#16a34a', '#7c3aed', '#fde047', '#808080', '#0f172a', '#fef2f2', ...CANVAS_SWATCHES.map((swatch) => swatch.colour)];

  it.each(brand)('keeps every colour it works out on %s', (canvas) => {
    const schemes = schemesForCanvas(canvas);
    const scheme = schemes.light ?? schemes.dark!;
    // One scheme: the diagram is drawn on that colour in light and in dark alike.
    expect(Object.keys(schemes)).toHaveLength(1);
    const { style } = normalizeStyle({ v: 1, hand: { base: 'clean' }, schemes });
    const themes = styleThemes(style);
    const theme = themes.light;
    expect(theme).toBe(themes.dark);
    // Nothing fell back to a built-in colour: every one cleared the floor a style is held to.
    expect(theme.canvas).toBe(canvas);
    expect(theme.text).toBe(scheme.text);
    expect(theme.edge).toBe(scheme.edge);
    for (const accent of ACCENTS) expect(theme.accents[accent], accent).toEqual(scheme.accents![accent]);
    // The bars and panels beside the canvas follow it, and their words still read.
    expect(contrast(theme.text, theme.surfaceRaised), 'words on a panel').toBeGreaterThanOrEqual(CONTRAST.text);
    expect(contrast(theme.textMuted, theme.surface), 'quiet words on a bar').toBeGreaterThanOrEqual(CONTRAST.muted);
  });

  it('carries a brand colour through a change of canvas or of colours', () => {
    const branded = withBrand(schemesForCanvas('#10162b'), '#f59e0b');
    expect(branded).toEqual({ dark: { ...schemesForCanvas('#10162b').dark, selection: '#f59e0b' } });
    expect(brandOf({ schemes: branded })).toBe('#f59e0b');
    // A brand alone is no palette of its own: the built-in colours are still what is in use.
    expect(paletteOf({ schemes: withBrand(undefined, '#f59e0b') })?.id).toBe('builtin');
    expect(withBrand(withBrand(undefined, '#f59e0b'), undefined)).toBeUndefined();
    expect(normalizeStyle({ v: 1, hand: { base: 'clean' }, schemes: branded }).style?.schemes?.dark?.selection).toBe('#f59e0b');
  });
});
