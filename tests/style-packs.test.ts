import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDocument, createNode } from '../src/document/factory';
import { KIND_FIELDS, STYLE_KINDS, STYLE_LIMITS, STYLE_SHAPE_KEYS, artSlotOf, normalizeStyle, type DocumentStyle, type StyleScheme } from '../src/document/style';
import { readStyleFile, serializeStyleFile } from '../src/document/styleFile';
import { ACCENTS, NODE_TYPES, type DraftNode, type DraftNodeType } from '../src/document/types';
import { parseCatalog } from '../src/gallery/catalog';
import { MAX_STYLE_PACK_BYTES } from '../src/gallery/source';
import { describeContext, describeNode, sizingContext } from '../src/nodes/describe';
import { drawnBounds, isWords } from '../src/render/style/art';
import { resolveStyle } from '../src/render/style/resolve';
import { renderDocumentSvg } from '../src/render/svg/document';
import { schemeTheme } from '../src/render/style/scheme';
import { THEMES, type ThemeName } from '../src/render/theme/tokens';

/**
 * The quality gate for gallery style packs: the vendored snapshot in `tests/fixtures/starters/` by
 * default, or any checkout of github.com/acltabontabon/draft-canvas-starters —
 *
 *   STARTERS_DIR=../draft-canvas-starters npx vitest run tests/style-packs.test.ts
 *
 * which is how that repository's CI checks a pack against the app that will draw it. A pack is a
 * style like any other, so it is held to what a style is held to (it reads back with nothing
 * repaired and no colour refused) and to what makes it a pack: it says how every shape, and every
 * kind of every shape, is drawn. The keys come from the app's own lists, so a kind added to the
 * app fails every pack that has not drawn it.
 */

const ROOT = resolve(process.env.STARTERS_DIR ?? join(__dirname, 'fixtures', 'starters'));
const STYLES = join(ROOT, 'styles');
const IDS = existsSync(STYLES) ? readdirSync(STYLES).filter((name) => statSync(join(STYLES, name)).isDirectory()).sort() : [];

const textOf = (id: string) => readFileSync(join(STYLES, id, `${id}.draftstyle`), 'utf8');
function packOf(id: string): DocumentStyle {
  const read = readStyleFile(textOf(id));
  if (!read.ok) throw new Error(`${id}: ${read.error}`);
  return read.style;
}

/** Every key a drawing can stand for: each kind of a type that has kinds, the type itself otherwise. */
const ART_KEYS: { key: string; type: DraftNodeType; kind?: string }[] = NODE_TYPES.flatMap((type): { key: string; type: DraftNodeType; kind?: string }[] => {
  const kinds = STYLE_KINDS[type].filter((kind) => artSlotOf(type, kind) !== null);
  if (kinds.length > 0) return kinds.map((kind) => ({ key: `${type}:${kind}`, type, kind }));
  return artSlotOf(type, undefined) !== null ? [{ key: type, type }] : [];
});

const nodeOf = (type: DraftNodeType, kind?: string): DraftNode => {
  const field = (KIND_FIELDS as Partial<Record<DraftNodeType, keyof DraftNode>>)[type];
  return createNode({ id: `n-${type}-${kind ?? 'any'}`, type, x: 0, y: 0, text: 'Name', ...(kind && field ? { [field]: kind } : {}) } as Parameters<typeof createNode>[0]);
};

describe('the style packs', () => {
  it('are there to check', () => {
    expect(IDS.length).toBeGreaterThanOrEqual(7);
    expect(ART_KEYS.length).toBeGreaterThanOrEqual(33);
  });

  it('are listed in the catalog exactly as they are on disk', () => {
    const parsed = parseCatalog(readFileSync(join(ROOT, 'catalog.json'), 'utf8'));
    if (!parsed.ok) throw new Error(parsed.reason);
    const listed = parsed.catalog.styles ?? [];
    expect(listed.map((entry) => entry.id).sort()).toEqual(IDS);
    for (const entry of listed) {
      const bytes = readFileSync(join(ROOT, entry.path));
      expect(entry.path, entry.id).toBe(`styles/${entry.id}/${entry.id}.draftstyle`);
      expect(createHash('sha256').update(bytes).digest('hex'), entry.id).toBe(entry.sha256);
      expect(bytes.length, entry.id).toBe(entry.bytes);
      expect(bytes.length, entry.id).toBeLessThanOrEqual(MAX_STYLE_PACK_BYTES);
      expect(entry.author, entry.id).not.toBe('');
      expect(entry.licence, entry.id).not.toBe('');
    }
  });
});

describe.each(IDS)('%s', (id) => {
  const style = packOf(id);
  const resolved = resolveStyle(style);

  it('reads back with nothing repaired, and is already the bytes the app would write', () => {
    const read = readStyleFile(textOf(id));
    expect(read.ok && read.repairs).toEqual([]);
    expect(normalizeStyle(JSON.parse(textOf(id)).style)).toEqual({ style, repairs: [] });
    expect(serializeStyleFile(style.name ?? id, style)).toBe(textOf(id));
  });

  it('draws every kind of every shape, or says it keeps the app’s own drawing', () => {
    const missing = ART_KEYS.filter(({ key, type }) => {
      const own = style.shapes?.[key];
      const family = style.shapes?.[type];
      return !(own?.art || own?.builtin || family?.art || family?.builtin);
    }).map(({ key }) => key);
    expect(missing).toEqual([]);
  });

  it('says nothing about a shape the app does not have', () => {
    expect(Object.keys(style.shapes ?? {}).filter((key) => !STYLE_SHAPE_KEYS.includes(key))).toEqual([]);
  });

  it('keeps only drawings it uses, each inside what a style may hold', () => {
    const used = new Set(Object.values(style.shapes ?? {}).flatMap((shape) => (shape.art ? [shape.art] : [])));
    // The canvas's backdrop is a drawing too: one tile, used by no shape.
    if (style.backdrop) used.add(style.backdrop.art);
    const assets = style.assets ?? [];
    expect(assets.map((asset) => asset.id).filter((assetId) => !used.has(assetId))).toEqual([]);
    expect(assets.length).toBeLessThanOrEqual(STYLE_LIMITS.maxAssets);
    for (const asset of assets) {
      expect(asset.paths.length, asset.id).toBeLessThanOrEqual(STYLE_LIMITS.maxAssetPaths);
      expect(asset.paths.reduce((sum, path) => sum + path.d.length, 0), asset.id).toBeLessThanOrEqual(STYLE_LIMITS.maxAssetChars);
    }
  });

  it('has a full set of colours for each theme it is drawn in, none of them refused', () => {
    const schemes = Object.entries(style.schemes ?? {}) as [ThemeName, StyleScheme][];
    expect(schemes.length).toBeGreaterThan(0);
    for (const [name, scheme] of schemes) {
      expect(scheme.canvas, `${name} canvas`).toBeDefined();
      expect(Object.keys(scheme.accents ?? {}).sort(), `${name} colours`).toEqual([...ACCENTS].sort());
      // Whatever the pack asks for is what is drawn: nothing fell back for being unreadable.
      const theme = schemeTheme(THEMES[name], scheme);
      for (const key of ['canvas', 'grid', 'text', 'textMuted', 'edge', 'edgeText', 'edgeLabelBg', 'codeBg', 'codeBorder'] as const) {
        if (scheme[key] !== undefined) expect(theme[key], `${name} ${key}`).toBe(scheme[key]);
      }
      for (const accent of ACCENTS) expect(theme.accents[accent], `${name} ${accent}`).toEqual(scheme.accents![accent]);
    }
  });

  it('draws each shape in place: the same size, the same words, the drawing where the built-in one was', () => {
    const theme = resolved.theme('light');
    for (const { key, type, kind } of ART_KEYS) {
      const node = nodeOf(type, kind);
      const plain = describeNode(node, describeContext(theme));
      const drawn = describeNode(node, describeContext(theme, resolved));
      expect([drawn.width, drawn.height], key).toEqual([plain.width, plain.height]);
      const flat = (shapes: typeof drawn.shapes): typeof drawn.shapes => shapes.flatMap((shape) => (shape.t === 'group' ? flat(shape.children) : [shape]));
      expect(flat(drawn.shapes).filter(isWords), key).toEqual(flat(plain.shapes).filter(isWords));
      if (resolved.shape(node).art) {
        const was = drawnBounds(plain.shapes)!;
        const now = drawnBounds(drawn.shapes)!;
        // A hat brim or the pull of a curve may reach a little past the place; the drawing itself may not leave it.
        const slack = Math.max(was.w, was.h) * 0.18;
        expect(now.x >= was.x - slack && now.y >= was.y - slack && now.x + now.w <= was.x + was.w + slack && now.y + now.h <= was.y + was.h + slack, key).toBe(true);
        // Not a speck in the corner of its place: a drawing takes up most of at least one side.
        expect(Math.max(now.w / was.w, now.h / was.h), key).toBeGreaterThan(0.6);
      }
      // A size is worked out without any style at all, so a pack cannot move anything.
      expect(sizingContext().style.shape(node).plain, key).toBe(true);
    }
  });

  it('prints a backdrop on its canvas, one tile of a size worth repeating', () => {
    const tile = resolved.backdrop?.art;
    expect(tile, 'a backdrop').toBeDefined();
    expect(Math.min(tile!.w, tile!.h)).toBeGreaterThanOrEqual(120);
    expect(Math.max(tile!.w, tile!.h)).toBeLessThanOrEqual(640);
  });

  it('draws External as its dashed card in the pack’s colours, its words clear, the old glyph kept but not drawn', () => {
    // External was a glyph before format 33, and the packs still carry that glyph for the apps that
    // draw one. Stretched over today's card it covered the name and the tag.
    const key = 'service:external';
    expect(style.shapes?.[key]?.art, 'kept for apps that draw External as a glyph').toBeDefined();
    const again = readStyleFile(serializeStyleFile(style.name ?? id, style));
    expect(again.ok && again.style.shapes?.[key]?.art, 'and still there once opened and saved here').toBe(style.shapes?.[key]?.art);
    const { art: _art, fit: _fit, ...rest } = style.shapes![key]!;
    const shapes = { ...style.shapes! };
    if (Object.keys(rest).length > 0) shapes[key] = rest;
    else delete shapes[key];
    const without: DocumentStyle = { ...style, shapes };
    const node = { ...nodeOf('service', 'external'), text: 'Payment Provider' };
    for (const name of ['light', 'dark'] as const) {
      const theme = resolved.theme(name);
      const drawn = describeNode(node, describeContext(theme, resolved));
      expect(drawn, name).toEqual(describeNode(node, describeContext(resolveStyle(without).theme(name), resolveStyle(without))));
      const flat = (list: typeof drawn.shapes): typeof drawn.shapes => list.flatMap((shape) => (shape.t === 'group' ? flat(shape.children) : [shape]));
      const words = flat(drawn.shapes).filter(isWords);
      expect(words, name).toEqual(flat(describeNode(node, describeContext(theme)).shapes).filter(isWords));
      expect(words.some((shape) => shape.t === 'text' && /payment/i.test(JSON.stringify(shape))), name).toBe(true);
      // The export reads the same describer: the same picture as with no drawing given at all.
      const doc = { ...createDocument(), nodes: [node] };
      expect(renderDocumentSvg({ ...doc, style }, { theme: name }).svg, name).toBe(renderDocumentSvg({ ...doc, style: without }, { theme: name }).svg);
    }
  });

  it('gives every kind that has a drawing one of its own', () => {
    const byArt = new Map<string, string[]>();
    for (const { key, type, kind } of ART_KEYS) {
      const art = resolved.shape(nodeOf(type, kind)).art;
      if (art) byArt.set(art.id, [...(byArt.get(art.id) ?? []), key]);
    }
    expect([...byArt.values()].filter((keys) => keys.length > 1)).toEqual([]);
  });
});
