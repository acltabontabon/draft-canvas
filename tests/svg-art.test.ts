/**
 * A style's own drawings: an SVG from anywhere becomes inert path data and nothing else, and a
 * shape drawn with one is the same shape (its size, its name, where a connector meets it) with a
 * different picture.
 */
import { describe, expect, it } from 'vitest';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { addEdges, addNodes } from '../src/document/operations';
import { STYLE_KINDS, STYLE_LIMITS, artSlotOf, normalizeAsset, normalizeStyle, pathCommands, type DocumentStyle, type StyleAsset } from '../src/document/style';
import { NODE_TYPES, type DraftNode, type DraftNodeType } from '../src/document/types';
import { importSvgArt, MAX_SVG_BYTES } from '../src/import/svgArt';
import { readPath, written } from '../src/render/style/pathData';
import { describeContext, describeNode, naturalArchitectureSize, sizingContext } from '../src/nodes/describe';
import type { Shape } from '../src/render/displayList';
import { artShapes, drawnBounds, isWords } from '../src/render/style/art';
import { resolveStyle } from '../src/render/style/resolve';
import { renderDocumentSvg } from '../src/render/svg/document';
import { serialize } from '../src/render/svg/element';
import { emitDisplayList } from '../src/render/svg/emit';
import { LIGHT } from '../src/render/theme/tokens';

const svg = (body: string, attrs = 'viewBox="0 0 100 100"') => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${attrs}>${body}</svg>`;
const imported = (text: string, mode: 'diagram' | 'original' = 'diagram') => {
  const result = importSvgArt(text, mode);
  if (!result.ok) throw new Error(result.message);
  return result;
};
const numbers = (d: string) => (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);

describe('reading path data', () => {
  const stored = (d: string) => written(readPath(d, 1000) as Exclude<ReturnType<typeof readPath>, null | 'limit'>, -1000, 2000);

  it('turns every command into absolute moves, lines, curves and closes', () => {
    expect(stored('M10 10 L20 10 20 20 Z')).toBe('M10 10L20 10L20 20Z');
    expect(stored('m10 10 l10 0 0 10 z')).toBe('M10 10L20 10L20 20Z');
    expect(stored('M0 0 h10 v10 H0 V0')).toBe('M0 0L10 0L10 10L0 10L0 0');
    expect(stored('M0 0 C1 2 3 4 5 6 S9 10 11 12')).toBe('M0 0C1 2 3 4 5 6C7 8 9 10 11 12');
    // A quadratic curve as the cubic that draws the same line.
    expect(stored('M0 0 Q30 0 30 30')).toBe('M0 0C20 0 30 10 30 30');
    // A move with more pairs: the rest are lines.
    expect(stored('M1 1 2 2 3 3')).toBe('M1 1L2 2L3 3');
    for (const d of ['M0 0 A10 10 0 0 1 20 0', 'M0 0a10 10 0 0120 0', 'M.5.5l1e1-2']) expect(pathCommands(stored(d)), d).not.toBeNull();
  });

  it('draws an arc as curves that pass where the arc does', () => {
    // A half circle from (0,0) to (20,0), bulging to y = -10.
    const d = stored('M0 0 A10 10 0 0 1 20 0');
    expect(d.startsWith('M0 0C')).toBe(true);
    const values = numbers(d);
    expect(values.slice(-2)).toEqual([20, 0]);
    expect(Math.min(...values.filter((_, index) => index % 2 === 1))).toBeCloseTo(-10, 0);
  });

  it('refuses what is not path data', () => {
    for (const d of ['', 'L0 0', '10 10', 'M0 0 X5 5', 'M0 0 L10', 'M0 0 Z 5 5', 'M0 0 L1 1 javascript:alert(1)', 'M0 0 A1 1 0 2 1 5 5', 'M0 0 L1e999 0']) {
      expect(readPath(d, 1000), d).toBeNull();
    }
    expect(readPath(`M0 0${'L1 1'.repeat(50)}`, 10)).toBe('limit');
  });
});

describe('importing an SVG', () => {
  it('keeps the shapes it draws, as stored paths in the picture’s own frame', () => {
    const { asset, notes } = imported(svg('<rect x="10" y="20" width="30" height="40" fill="#336699"/><circle cx="70" cy="70" r="10" fill="#336699"/>'));
    expect(notes).toEqual([]);
    expect(asset).toEqual(normalizeAsset(asset));
    expect([asset.w, asset.h]).toEqual([100, 100]);
    // Painted alike, so one path: the square, then the circle.
    expect(asset.paths).toHaveLength(1);
    expect(asset.paths[0]!.d.startsWith('M10 20L40 20L40 60L10 60Z')).toBe(true);
    expect(pathCommands(asset.paths[0]!.d)).toBeGreaterThan(5);
    for (const path of asset.paths) expect(pathCommands(path.d)).not.toBeNull();
  });

  it('is the same drawing, with the same id, every time', () => {
    const text = svg('<path d="M10 10h80v80h-80z" fill="red"/>');
    expect(imported(text).asset).toEqual(imported(text).asset);
    expect(imported(text).asset.id).not.toBe(imported(svg('<path d="M10 10h80v80h-81z" fill="red"/>')).asset.id);
    expect(imported(text).asset.id).toMatch(/^a[0-9a-z]{8,16}$/);
  });

  it('folds transforms, groups and reuse into the coordinates', () => {
    const { asset } = imported(
      svg('<defs><rect id="box" width="10" height="10"/></defs><g transform="translate(20 30)"><use href="#box" transform="scale(2)" fill="#000"/><use xlink:href="#box" x="50" fill="#000"/></g>'),
    );
    const d = asset.paths.map((path) => path.d).join('');
    expect(d).toContain('M20 30L40 30L40 50L20 50Z');
    expect(d).toContain('M70 30L80 30L80 40L70 40Z');
  });

  it('maps a frame that starts elsewhere, and brings a tiny or a huge picture to a workable size', () => {
    const moved = imported(svg('<rect x="110" y="210" width="50" height="50" fill="#000"/>', 'viewBox="100 200 100 100"')).asset;
    expect(moved.paths[0]!.d).toBe('M10 10L60 10L60 60L10 60Z');
    const tiny = imported(svg('<rect x="0" y="0" width="12" height="24" fill="#000"/>', 'viewBox="0 0 24 24"')).asset;
    expect([tiny.w, tiny.h]).toEqual([240, 240]);
    expect(tiny.paths[0]!.d).toBe('M0 0L120 0L120 240L0 240Z');
    const huge = imported(svg('<rect width="2500" height="5000" fill="#000"/>', 'width="5000" height="5000"')).asset;
    expect(Math.max(huge.w, huge.h)).toBeLessThanOrEqual(STYLE_LIMITS.maxArtUnits);
    // No frame at all: whatever it drew on.
    const bare = imported('<svg xmlns="http://www.w3.org/2000/svg"><rect x="50" y="50" width="100" height="60" fill="#000"/></svg>').asset;
    expect([bare.w, bare.h]).toEqual([100, 60]);
  });

  it('paints in the shape’s own colour, or keeps its own', () => {
    const two = svg('<rect width="100" height="100" fill="#ffffff" stroke="#222222" stroke-width="4"/><circle cx="50" cy="50" r="20" fill="#202020"/>');
    expect(imported(two).asset.paths.map((path) => [path.fill, path.stroke])).toEqual([
      ['fill', 'line'],
      ['line', undefined],
    ]);
    expect(imported(two, 'original').asset.paths.map((path) => [path.fill, path.stroke])).toEqual([
      ['#ffffff', '#222222'],
      ['#202020', undefined],
    ]);
    // A picture of one colour is its outline.
    expect(imported(svg('<path d="M0 0h50v50z" fill="#ff8800"/>')).asset.paths[0]!.fill).toBe('line');
    // The page's text colour is the shape's line colour, whichever is asked for.
    expect(imported(svg('<path d="M0 0h50v50z" fill="currentColor"/>'), 'original').asset.paths[0]!.fill).toBe('line');
    // SVG's own default: black fill, no stroke.
    expect(imported(svg('<path d="M0 0h50v50z"/>'), 'original').asset.paths[0]).toMatchObject({ fill: '#000000' });
  });

  it('reads colour, opacity and fill rule from attributes and from the element’s own style', () => {
    const { asset } = imported(
      svg('<g opacity="0.5"><path d="M0 0h50v50z" style="fill: rgb(255, 0, 0); fill-opacity: .5; fill-rule: evenodd"/></g><path d="M0 60h50" fill="none" stroke="#0a0" stroke-width="3"/>'),
      'original',
    );
    expect(asset.paths[0]).toMatchObject({ fill: '#ff0000', o: 0.25, rule: 'evenodd' });
    expect(asset.paths[1]).toMatchObject({ stroke: '#00aa00', sw: 3 });
    expect(asset.paths[1]!.fill).toBeUndefined();
  });

  it('leaves out what a drawing cannot keep, and says so', () => {
    const { asset, notes } = imported(
      svg(
        '<style>.a{fill:red}</style><defs><linearGradient id="g"><stop offset="0" stop-color="#123456"/><stop offset="1" stop-color="#fff"/></linearGradient></defs>' +
          '<text x="5" y="20">Hello</text><image href="https://example.test/track.png" width="10" height="10"/>' +
          '<rect width="40" height="40" fill="url(#g)"/><rect x="50" width="40" height="40" display="none" fill="#000"/>',
      ),
      'original',
    );
    expect(asset.paths).toHaveLength(1);
    expect(asset.paths[0]!.fill).toBe('#123456');
    expect(notes).toEqual(expect.arrayContaining(['Text, images and effects were left out.', 'Gradients and patterns were drawn as one colour.', expect.stringContaining('style sheet')]));
  });

  it('says plainly when there is nothing to use', () => {
    const fails = (text: string) => {
      const result = importSvgArt(text);
      return result.ok ? null : result.message;
    };
    expect(fails('')).toBe('This file isn’t an SVG picture.');
    expect(fails('not xml at all')).toBe('This file isn’t an SVG picture.');
    expect(fails('<html><body><svg/></body></html>')).toBe('This file isn’t an SVG picture.');
    expect(fails(svg('<path d="M0 0h10"'))).toBe('This file isn’t an SVG picture.');
    expect(fails(svg('<text>Only words</text>'))).toBe('Nothing in this picture can be drawn as a shape.');
    expect(fails(svg('<rect width="10" height="10" fill="none"/>'))).toBe('Nothing in this picture can be drawn as a shape.');
    expect(fails(svg(`<path d="M0 0${'l1 1'.repeat(7000)}" fill="#000"/>`))).toBe('This picture is too detailed to use as a shape. Simplify it and try again.');
    expect(fails(svg(`<!-- ${'x'.repeat(MAX_SVG_BYTES)} --><rect width="1" height="1"/>`))).toBe('This picture is too detailed to use as a shape. Simplify it and try again.');
    expect(fails(svg(Array.from({ length: 2100 }, () => '<g/>').join('')))).toBe('This picture is too detailed to use as a shape. Simplify it and try again.');
  });
});

describe('a hostile SVG', () => {
  /** Everything that came out of an import, as one string to look for leftovers in. */
  const everything = (text: string) => {
    const result = importSvgArt(text, 'original');
    return result.ok ? JSON.stringify(result.asset) : '';
  };

  const HOSTILE = [
    svg('<script>alert(1)</script><rect width="10" height="10" fill="#000"/>'),
    svg('<rect width="10" height="10" fill="#000" onclick="alert(1)" onload="fetch(\'https://example.test\')"/>'),
    svg('<a href="javascript:alert(1)"><rect width="10" height="10" fill="#000"/></a>'),
    svg('<foreignObject><iframe src="https://example.test"></iframe></foreignObject><rect width="10" height="10" fill="#000"/>'),
    svg('<image href="https://example.test/pixel.png" width="10" height="10"/><rect width="10" height="10" fill="#000"/>'),
    svg('<use href="https://example.test/sprite.svg#icon"/><use xlink:href="file:///etc/passwd#x"/><rect width="10" height="10" fill="#000"/>'),
    svg('<rect width="10" height="10" fill="url(https://example.test/paint.svg#g)"/><rect width="10" height="10" fill="#000"/>'),
    svg('<rect width="10" height="10" style="fill: url(\'https://example.test/x\'); background: url(javascript:alert(1))"/><rect width="10" height="10" fill="#000"/>'),
    svg('<style>@import url("https://example.test/a.css"); rect { fill: red }</style><rect width="10" height="10" fill="#000"/>'),
    svg('<rect width="10" height="10" fill="#000"><animate attributeName="href" to="javascript:alert(1)"/><set attributeName="onclick" to="alert(1)"/></rect>'),
    svg('<path d="M0 0h10v10z" fill="#000" id="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"/>'),
  ];

  it('leaves nothing behind but numbers, path letters and colours', () => {
    for (const text of HOSTILE) {
      const out = everything(text);
      expect(out, text).not.toBe('');
      expect(out, text).not.toMatch(/script|alert|javascript|https?:|file:|href|onclick|onload|url\(|import|iframe|example/i);
      const { asset } = imported(text, 'original');
      // The stored form and nothing else: every string in it is a path, a role or a colour.
      expect(normalizeAsset(JSON.parse(JSON.stringify(asset)))).toEqual(asset);
      for (const path of asset.paths) {
        expect(path.d).toMatch(/^[MLCZ0-9 .-]+$/);
        for (const paint of [path.fill, path.stroke]) if (paint) expect(paint).toMatch(/^(#[0-9a-f]{6}|fill|line|text|chip|canvas)$/);
      }
    }
  });

  it('never reads an entity, so one cannot be made to expand', () => {
    const bomb = `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;">]>${svg('<text>&c;</text><rect width="10" height="10" fill="#000"/>')}`;
    expect(importSvgArt(bomb)).toEqual({ ok: false, message: 'This file isn’t an SVG picture.' });
    expect(importSvgArt(`<!DOCTYPE svg SYSTEM "https://example.test/evil.dtd">${svg('<rect width="1" height="1"/>')}`).ok).toBe(false);
  });

  it('cannot ask for unbounded work through reuse, nesting or numbers', () => {
    // Each use draws the one before it twice: a few lines of file, a great many shapes.
    const doubling = Array.from({ length: 24 }, (_, index) => `<g id="g${index + 1}"><use href="#g${index}"/><use href="#g${index}" x="1"/></g>`).join('');
    const started = Date.now();
    const result = importSvgArt(svg(`<defs><rect id="g0" width="1" height="1" fill="#000"/>${doubling}</defs><use href="#g24"/>`));
    expect(Date.now() - started).toBeLessThan(2000);
    if (result.ok) expect(result.asset.paths.reduce((sum, path) => sum + path.d.length, 0)).toBeLessThanOrEqual(STYLE_LIMITS.maxAssetChars);
    // A reference to itself.
    expect(importSvgArt(svg('<g id="loop"><use href="#loop"/><rect width="5" height="5" fill="#000"/></g>')).ok).toBe(true);
    // Coordinates that could not be stored are held to the drawing's reach, never written as they are.
    const far = imported(svg('<path d="M-1e9 -1e9 L1e9 1e9 L50 50 Z" fill="#000"/>')).asset;
    for (const value of numbers(far.paths[0]!.d)) expect(Math.abs(value)).toBeLessThanOrEqual(STYLE_LIMITS.maxArtCoordinate);
    expect(importSvgArt(svg('<rect width="NaN" height="Infinity" fill="#000"/><circle r="-5" fill="#000"/>')).ok).toBe(false);
  });
});

describe('a shape drawn with a style’s own drawing', () => {
  const HOUSE: StyleAsset = imported(svg('<path d="M10 50 L50 10 L90 50 V90 H10 Z" fill="#ffffff" stroke="#111111" stroke-width="4"/><rect x="42" y="60" width="16" height="30" fill="#111111"/>')).asset;
  const styleWith = (shapes: DocumentStyle['shapes']): DocumentStyle => ({ v: 1, hand: { base: 'clean' }, shapes, assets: [HOUSE] });
  const flat = (shapes: readonly Shape[]): Shape[] => shapes.flatMap((shape) => (shape.t === 'group' ? flat(shape.children) : [shape]));
  const kindField: Partial<Record<DraftNodeType, keyof DraftNode>> = { service: 'serviceKind', database: 'databaseKind', queue: 'queueKind', actor: 'actorKind', component: 'componentKind', artifact: 'artifactKind' };
  const every: { type: DraftNodeType; kind?: string }[] = NODE_TYPES.flatMap((type) => [{ type }, ...STYLE_KINDS[type].map((kind) => ({ type, kind }))]);
  const nodeOf = ({ type, kind }: { type: DraftNodeType; kind?: string }) =>
    createNode({ id: `n-${type}-${kind ?? 'any'}`, type, x: 0, y: 0, text: 'Ledger', ...(kind && kindField[type] ? { [kindField[type]!]: kind } : {}) } as Parameters<typeof createNode>[0]);

  it('is placed by moving its numbers: in a box, filling it or keeping its proportions', () => {
    const stretched = artShapes(HOUSE, { x: 10, y: 20, w: 200, h: 50 }, 'stretch', LIGHT.accents.teal, LIGHT);
    expect(drawnBounds(stretched)).toEqual({ x: 30, y: 25, w: 160, h: 40 });
    const contained = artShapes(HOUSE, { x: 10, y: 20, w: 200, h: 50 }, 'contain', LIGHT.accents.teal, LIGHT);
    // 50 tall, so half scale, centred in the 200 wide box.
    expect(drawnBounds(contained)).toEqual({ x: 90, y: 25, w: 40, h: 40 });
    expect(stretched.map((shape) => (shape.t === 'path' ? [shape.fill, shape.stroke?.color] : []))).toEqual([
      [LIGHT.accents.teal.fill, LIGHT.accents.teal.line],
      [LIGHT.accents.teal.line, undefined],
    ]);
  });

  it('draws what it holds, not what another drawing under the same id held', () => {
    // A style from a file can reuse an id; the placed paths were once cached by id alone.
    const first = artShapes(HOUSE, { x: 0, y: 0, w: 48, h: 48 }, 'stretch', LIGHT.accents.teal, LIGHT);
    const other = { ...HOUSE, paths: HOUSE.paths.map((path) => ({ ...path, d: 'M1 1L5 5Z' })) };
    const second = artShapes(other, { x: 0, y: 0, w: 48, h: 48 }, 'stretch', LIGHT.accents.teal, LIGHT);
    expect(second.map((shape) => (shape.t === 'path' ? shape.d : ''))).not.toEqual(first.map((shape) => (shape.t === 'path' ? shape.d : '')));
  });

  it('keeps its words where they were and changes nothing else about the shape', () => {
    const resolved = resolveStyle(styleWith(Object.fromEntries(NODE_TYPES.map((type) => [type, { art: HOUSE.id }]))));
    for (const entry of every) {
      const node = nodeOf(entry);
      const label = `${entry.type}:${entry.kind ?? ''}`;
      const plain = describeNode(node, describeContext(LIGHT));
      const drawn = describeNode(node, describeContext(LIGHT, resolved));
      expect([drawn.width, drawn.height], label).toEqual([plain.width, plain.height]);
      expect(flat(drawn.shapes).filter(isWords), label).toEqual(flat(plain.shapes).filter(isWords));
      if (artSlotOf(entry.type, entry.kind) === null) {
        // Text, notes, code, sequences and boundaries hold their own content: no drawing covers it.
        expect(drawn, label).toEqual(plain);
      } else {
        expect(drawn.shapes.filter((shape) => !isWords(shape)), label).toHaveLength(HOUSE.paths.length);
        // Where the built-in drawing was, and no further.
        const was = drawnBounds(plain.shapes)!;
        const now = drawnBounds(drawn.shapes)!;
        expect(now.x, label).toBeGreaterThanOrEqual(was.x - 0.01);
        expect(now.y, label).toBeGreaterThanOrEqual(was.y - 0.01);
        expect(now.x + now.w, label).toBeLessThanOrEqual(was.x + was.w + 0.01);
        expect(now.y + now.h, label).toBeLessThanOrEqual(was.y + was.h + 0.01);
      }
      expect(naturalArchitectureSize(node, describeContext(LIGHT, resolved)), label).toEqual(naturalArchitectureSize(node, sizingContext()));
    }
  });

  it('lets a kind keep the built-in drawing when its whole type has one', () => {
    const resolved = resolveStyle(styleWith({ database: { art: HOUSE.id }, 'database:cache': { builtin: true } }));
    const cache = createNode({ id: 'c', type: 'database', x: 0, y: 0, text: 'Cache', databaseKind: 'cache' });
    const sql = createNode({ id: 's', type: 'database', x: 0, y: 0, text: 'Orders', databaseKind: 'sql' });
    expect(describeNode(cache, describeContext(LIGHT, resolved))).toEqual(describeNode(cache, describeContext(LIGHT)));
    expect(describeNode(sql, describeContext(LIGHT, resolved))).not.toEqual(describeNode(sql, describeContext(LIGHT)));
  });

  it('still says how many of a service there are', () => {
    const resolved = resolveStyle(styleWith({ service: { art: HOUSE.id } }));
    const node = { ...createNode({ id: 'r', type: 'service', x: 0, y: 0, text: 'API' }), replicas: 3 };
    const words = flat(describeNode(node, describeContext(LIGHT, resolved)).shapes).filter((shape) => shape.t === 'text');
    expect(words.some((shape) => shape.t === 'text' && shape.layout.lines.some((line) => line.text === '×3'))).toBe(true);
  });

  it('meets its connectors exactly where the built-in shape does', () => {
    const a = createNode({ id: 'a', type: 'database', x: 0, y: 0, text: 'Ledger' });
    const b = createNode({ id: 'b', type: 'service', x: 420, y: 40, text: 'Orders', serviceKind: 'gateway' });
    const edge = createEdge({ id: 'e', source: 'a', target: 'b' });
    const plain = addEdges(addNodes(createDocument('Anchors'), [a, b]), [edge]);
    const styled = { ...plain, style: styleWith({ database: { art: HOUSE.id }, service: { art: HOUSE.id } }) };
    // Routing reads the shapes, never the style: the line drawn is the same line.
    const line = (markup: string) => /<path[^>]*marker-end[^>]*\sd="([^"]+)"|<path[^>]*\sd="([^"]+)"[^>]*marker-end/.exec(markup)?.slice(1).find(Boolean);
    expect(line(renderDocumentSvg(styled, { theme: 'light' }).svg)).toBe(line(renderDocumentSvg(plain, { theme: 'light' }).svg));
  });

  it('reaches the picture as plain paths, with a hole kept a hole', () => {
    const ring = imported(svg('<path fill-rule="evenodd" d="M0 0h100v100h-100z M30 30h40v40h-40z" fill="#000"/>')).asset;
    const markup = emitDisplayList({ width: 100, height: 100, shapes: artShapes(ring, { x: 0, y: 0, w: 100, h: 100 }, 'stretch', LIGHT.accents.neutral, LIGHT) })
      .map(serialize)
      .join('');
    expect(markup).toContain('fill-rule="evenodd"');
    expect(markup).not.toMatch(/<(?!path\b|\/path\b)[a-z]/);
  });

  it('travels in a style, and is dropped from one that no longer uses it', () => {
    const style = styleWith({ database: { art: HOUSE.id } });
    expect(normalizeStyle(JSON.parse(JSON.stringify(style))).style).toEqual(style);
    expect(normalizeStyle({ ...style, shapes: {} }).style?.assets).toBeUndefined();
  });
});
