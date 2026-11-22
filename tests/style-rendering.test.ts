/**
 * What a style does to the picture: each shape inherits what it does not set, colours that cannot
 * be read fall back, and a styled diagram is drawn the same whoever opens it.
 */
import { describe, expect, it } from 'vitest';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { addEdges, addNodes } from '../src/document/operations';
import { HAND_PRESETS, type DocumentStyle, type StyleScheme } from '../src/document/style';
import type { DraftDocument } from '../src/document/types';
import { resolveEdgeColor } from '../src/edges/kindStyle';
import { contrast } from '../src/lib/colour';
import { describeContext, describeNode, naturalArchitectureSize, sizingContext } from '../src/nodes/describe';
import { connectorHead } from '../src/render/connectorStyle';
import type { Shape } from '../src/render/displayList';
import { PERSONALITY_PROFILES } from '../src/render/roughness/presets';
import { PLAIN_SHAPE, builtinStyle, resolveStyle } from '../src/render/style/resolve';
import { restyle } from '../src/render/style/restyle';
import { CONTRAST, pinnedTheme, schemeTheme } from '../src/render/style/scheme';
import { renderDocumentSvg } from '../src/render/svg/document';
import { DARK, LIGHT } from '../src/render/theme/tokens';

const style = (extra: Partial<DocumentStyle> = {}): DocumentStyle => ({ v: 1, hand: { base: 'clean' }, ...extra });

const flat = (shapes: readonly Shape[]): Shape[] => shapes.flatMap((shape) => (shape.t === 'group' ? flat(shape.children) : [shape]));
const strokes = (shapes: readonly Shape[]): number[] => flat(shapes).flatMap((shape) => ('stroke' in shape && shape.stroke ? [shape.stroke.width] : []));

describe('resolving a style', () => {
  it('follows the device when the diagram has none, and never when it has one', () => {
    for (const preset of HAND_PRESETS) expect(resolveStyle(undefined, preset)).toBe(builtinStyle(preset));
    const own = style({ hand: { base: 'draft' } });
    expect(resolveStyle(own, 'sketch').hand).toBe(PERSONALITY_PROFILES.draft);
    expect(resolveStyle(own, 'clean')).toBe(resolveStyle(own, 'sketch'));
  });

  it('is worked out once per style', () => {
    const own = style({ general: { weight: 'bold' } });
    expect(resolveStyle(own)).toBe(resolveStyle(own));
    expect(resolveStyle(own).key).not.toBe(resolveStyle(style({ general: { weight: 'bold' } })).key);
  });

  it('lets a kind inherit from its type, its type from the general look, and that from the built-in', () => {
    const resolved = resolveStyle(
      style({
        general: { weight: 'bold', corners: 'round' },
        shapes: { service: { corners: 'sharp' }, 'service:gateway': { weight: 'fine', shadow: false } },
      }),
    );
    const of = (node: Parameters<typeof resolved.shape>[0]) => resolved.shape(node);
    expect(of({ type: 'service', serviceKind: 'gateway' })).toMatchObject({ weight: 0.8, corners: 'sharp', shadow: false });
    expect(of({ type: 'service', serviceKind: 'api' })).toMatchObject({ weight: 1.3, corners: 'sharp', shadow: true });
    // No kind of its own is the type's first kind.
    expect(of({ type: 'service' })).toEqual(of({ type: 'service', serviceKind: 'generic' }));
    expect(of({ type: 'database' })).toMatchObject({ weight: 1.3, corners: 'round', shadow: true });
    expect(resolveStyle(style()).shape({ type: 'note' })).toBe(PLAIN_SHAPE);
  });

  it('turns a hand down or up, and leaves Clean steady whatever is asked', () => {
    const calm = resolveStyle(style({ hand: { base: 'sketch', wobble: 'calm', retrace: false } })).hand;
    expect(calm.outline).toBeLessThan(PERSONALITY_PROFILES.sketch.outline);
    expect(calm.strokes).toBe(1);
    expect(calm.arrowStyle).toBe(PERSONALITY_PROFILES.sketch.arrowStyle);
    expect(resolveStyle(style({ hand: { base: 'draft', wobble: 'lively' } })).hand.bow).toBeGreaterThan(PERSONALITY_PROFILES.draft.bow);
    expect(resolveStyle(style({ hand: { base: 'clean', wobble: 'lively', retrace: true } })).hand).toBe(PERSONALITY_PROFILES.clean);
  });
});

describe('a styled shape', () => {
  const node = createNode({ id: 'svc', type: 'service', x: 0, y: 0, text: 'Billing' });

  it('is drawn exactly as before when its style changes nothing about it', () => {
    const untouched = resolveStyle(style({ shapes: { database: { weight: 'bold' } } }));
    expect(describeNode(node, describeContext(LIGHT, untouched))).toEqual(describeNode(node, describeContext(LIGHT)));
  });

  it('gets heavier or lighter everywhere at once, and nothing moves', () => {
    const plain = describeNode(node, describeContext(LIGHT));
    const bold = describeNode(node, describeContext(LIGHT, resolveStyle(style({ general: { weight: 'bold' } }))));
    expect(strokes(bold.shapes)).toEqual(strokes(plain.shapes).map((width) => Math.round(width * 1.3 * 100) / 100));
    const still = (list: readonly Shape[]) => flat(list).map((shape) => ({ ...shape, stroke: undefined }));
    expect(still(bold.shapes)).toEqual(still(plain.shapes));
    expect([bold.width, bold.height]).toEqual([plain.width, plain.height]);
  });

  it('loses its shadow when its style is flat, and only then', () => {
    const shadows = (list: readonly Shape[]) => flat(list).filter((shape) => 'shadow' in shape && shape.shadow).length;
    expect(shadows(describeNode(node, describeContext(LIGHT)).shapes)).toBeGreaterThan(0);
    expect(shadows(describeNode(node, describeContext(LIGHT, resolveStyle(style({ general: { shadow: false } })))).shapes)).toBe(0);
  });

  it('rounds every kind of body, and the pieces of a glyph not at all', () => {
    const round = resolveStyle(style({ general: { corners: 'round' } }));
    for (const node of [
      createNode({ id: 'api', type: 'service', x: 0, y: 0, text: 'API', serviceKind: 'api' }),
      createNode({ id: 'cmp', type: 'component', x: 0, y: 0, text: 'Part' }),
      createNode({ id: 'note', type: 'note', x: 0, y: 0, text: 'Note' }),
      createNode({ id: 'grp', type: 'group', x: 0, y: 0, text: 'Scope', boundaryPreset: 'system' }),
    ]) {
      expect(describeNode(node, describeContext(LIGHT, round)), node.id).not.toEqual(describeNode(node, describeContext(LIGHT)));
    }
    // A gateway is a glyph: nothing about it is a box with corners to set.
    const gateway = createNode({ id: 'gw', type: 'service', x: 0, y: 0, text: 'Edge', serviceKind: 'gateway' });
    expect(describeNode(gateway, describeContext(LIGHT, round))).toEqual(describeNode(gateway, describeContext(LIGHT)));
  });

  it('takes sharper or rounder corners without changing its box', () => {
    const radius = (corners: 'sharp' | 'soft' | 'round') => {
      const drawn = describeNode(node, describeContext(LIGHT, resolveStyle(style({ general: { corners } }))));
      const outline = flat(drawn.shapes).find((shape) => shape.t === 'rect');
      return outline?.t === 'rect' ? outline.r ?? 0 : -1;
    };
    expect(radius('sharp')).toBeLessThan(radius('soft'));
    expect(radius('round')).toBeGreaterThan(radius('soft'));
    // Never past half the shape's shorter side.
    expect(radius('round')).toBeLessThanOrEqual(node.height / 2);
  });

  it('never changes the shape it was given, and returns the same list when there is nothing to do', () => {
    const shapes = describeNode(node, describeContext(LIGHT)).shapes;
    const frozen = JSON.stringify(shapes);
    expect(restyle(shapes, PLAIN_SHAPE)).toBe(shapes);
    restyle(shapes, { ...PLAIN_SHAPE, weight: 1.3, shadow: false, plain: false });
    expect(JSON.stringify(shapes)).toBe(frozen);
  });

  it('is the same size whatever its style, because a size is stored in the file', () => {
    const heavy = resolveStyle(style({ hand: { base: 'sketch' }, general: { weight: 'bold', corners: 'round', shadow: false } }));
    expect(sizingContext().style).toBe(builtinStyle('clean'));
    expect(naturalArchitectureSize(node, describeContext(LIGHT, heavy))).toEqual(naturalArchitectureSize(node, sizingContext()));
  });
});

describe('a style’s colours', () => {
  const parchment: StyleScheme = {
    canvas: '#f6e7c8',
    text: '#3a2a1a',
    textMuted: '#6b4f33',
    edge: '#7a5a3a',
    accents: { teal: { fill: '#fdf6e3', line: '#2f6f66', text: '#17443e', chip: '#2f6f66' } },
  };

  it('replace only what they name', () => {
    const theme = schemeTheme(LIGHT, parchment);
    expect(theme.canvas).toBe('#f6e7c8');
    expect(theme.accents.teal.line).toBe('#2f6f66');
    expect(theme.accents.blue).toBe(LIGHT.accents.blue);
    // App chrome is never a style's to change.
    expect([theme.surface, theme.border, theme.selection, theme.danger]).toEqual([LIGHT.surface, LIGHT.border, LIGHT.selection, LIGHT.danger]);
    expect(schemeTheme(LIGHT, undefined)).toBe(LIGHT);
    expect(schemeTheme(LIGHT, {})).toBe(LIGHT);
  });

  it('fall back, alone, when words could not be read on them', () => {
    // White words on a white canvas: the canvas colours are refused as a set, the good accent kept.
    const unreadable = schemeTheme(LIGHT, { ...parchment, canvas: '#ffffff', text: '#fefefe' });
    expect(unreadable.canvas).toBe(LIGHT.canvas);
    expect(unreadable.text).toBe(LIGHT.text);
    expect(unreadable.accents.teal.line).toBe('#2f6f66');
    // A name nobody could read on its own fill: that one colour is refused.
    const faint = schemeTheme(LIGHT, { ...parchment, accents: { teal: { fill: '#ffffff', line: '#2f6f66', text: '#f4f4f4', chip: '#2f6f66' } } });
    expect(faint.canvas).toBe('#f6e7c8');
    expect(faint.accents.teal).toBe(LIGHT.accents.teal);
  });

  it('always clear the floors once resolved', () => {
    for (const scheme of [parchment, { canvas: '#101010', text: '#111111' }, { accents: { rose: { fill: '#000000', line: '#000001', text: '#000002', chip: '#000003' } } }] as StyleScheme[]) {
      for (const base of [LIGHT, DARK]) {
        const theme = schemeTheme(base, scheme);
        expect(contrast(theme.text, theme.canvas)).toBeGreaterThanOrEqual(CONTRAST.text);
        for (const palette of Object.values(theme.accents)) expect(contrast(palette.text, palette.fill)).toBeGreaterThanOrEqual(CONTRAST.label);
      }
    }
  });

  it('follow the device with both a light and a dark set, and pin the diagram with one', () => {
    const night: StyleScheme = { canvas: '#120c1f', text: '#e6dbff', textMuted: '#b9a8e0', edge: '#8f7fc0', edgeText: '#c9b8f5', edgeLabelBg: '#1e1436' };
    const both = resolveStyle(style({ schemes: { light: parchment, dark: night } }));
    expect(both.pinned).toBeUndefined();
    expect(both.theme('light').canvas).toBe('#f6e7c8');
    expect(both.theme('dark').canvas).toBe('#120c1f');

    const dark = style({ schemes: { dark: night } });
    expect(pinnedTheme(dark)).toBe('dark');
    const pinned = resolveStyle(dark);
    expect(pinned.pinned).toBe('dark');
    expect(pinned.theme('light')).toBe(pinned.theme('dark'));
    expect(pinned.theme('light').name).toBe('dark');

    const none = resolveStyle(style());
    expect(none.theme('light')).toBe(LIGHT);
    expect(none.theme('dark')).toBe(DARK);
  });
});

describe('a style’s connectors', () => {
  it('weigh more or less, in every style at a hair under a shape’s outline', () => {
    expect(resolveStyle(style()).connector).toEqual({ lineWidth: 1.8, head: 'nib', colour: 'source' });
    expect(resolveStyle(style({ connectors: { weight: 'fine' } })).connector.lineWidth).toBe(1.4);
    expect(resolveStyle(style({ connectors: { weight: 'bold' } })).connector.lineWidth).toBe(2.4);
  });

  it('draw either head in the same box with the same tip, so a route never depends on the choice', () => {
    const numbers = (d: string) => (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    for (const open of [false, true]) {
      for (const head of ['nib', 'triangle'] as const) {
        const coords = numbers(connectorHead(open, head));
        const xs = coords.filter((_, index) => index % 2 === 0);
        const ys = coords.filter((_, index) => index % 2 === 1);
        expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)], `${head} ${open}`).toEqual([0, 14, 0, 8]);
        expect(connectorHead(open, head)).toContain('14 4');
      }
    }
    expect(connectorHead(false)).toBe(connectorHead(false, 'nib'));
  });

  it('take their source’s colour, or the plain line colour when the style says so', () => {
    const edge = createEdge({ id: 'e', source: 'a', target: 'b' });
    const source = { accent: 'teal' as const };
    expect(resolveEdgeColor(edge, source, LIGHT)).toBe(LIGHT.accents.teal.line);
    expect(resolveEdgeColor(edge, source, LIGHT, 'plain')).toBe(LIGHT.edge);
    // A colour someone chose for the connector itself is theirs either way.
    expect(resolveEdgeColor({ ...edge, accent: 'rose' }, source, LIGHT, 'plain')).toBe(LIGHT.accents.rose.chip);
  });
});

describe('a picture of a styled diagram', () => {
  const base = (): DraftDocument => {
    const a = createNode({ id: 'a', type: 'service', x: 0, y: 0, text: 'Orders' });
    const b = createNode({ id: 'b', type: 'database', x: 360, y: 0, text: 'Ledger' });
    return addEdges(addNodes(createDocument('Picture'), [a, b]), [createEdge({ id: 'e', source: 'a', target: 'b' })]);
  };
  const night: StyleScheme = { canvas: '#120c1f', text: '#e6dbff', textMuted: '#b9a8e0', edge: '#8f7fc0', edgeText: '#c9b8f5', edgeLabelBg: '#1e1436' };

  it('is the same from every device, where an unstyled one follows the device', () => {
    const plain = base();
    expect(renderDocumentSvg(plain, { theme: 'light', preset: 'sketch' }).svg).not.toBe(renderDocumentSvg(plain, { theme: 'light', preset: 'clean' }).svg);

    const own: DraftDocument = { ...plain, style: style({ hand: { base: 'draft' }, general: { weight: 'bold' } }) };
    const onSketch = renderDocumentSvg(own, { theme: 'light', preset: 'sketch' }).svg;
    expect(onSketch).toBe(renderDocumentSvg(own, { theme: 'light', preset: 'clean' }).svg);
    expect(onSketch).not.toBe(renderDocumentSvg(plain, { theme: 'light', preset: 'draft' }).svg);
  });

  it('with no style of its own is drawn in the style in use on this device, all of it', () => {
    const plain = base();
    const mine = style({ general: { weight: 'bold' }, connectors: { head: 'triangle' } });
    const drawn = renderDocumentSvg(plain, { theme: 'light', deviceStyle: mine }).svg;
    expect(drawn).toBe(renderDocumentSvg({ ...plain, style: mine }, { theme: 'light' }).svg);
    expect(drawn).toContain('M14 4 L0 0 L0 8 Z');
    // Its own style, when it has one, is the one that counts.
    const own: DraftDocument = { ...plain, style: style({ hand: { base: 'clean' } }) };
    expect(renderDocumentSvg(own, { theme: 'light', deviceStyle: mine }).svg).toBe(renderDocumentSvg(own, { theme: 'light' }).svg);
  });

  it('is drawn in the one theme a pinned style has, whichever is asked for', () => {
    const own: DraftDocument = { ...base(), style: style({ schemes: { dark: night } }) };
    const light = renderDocumentSvg(own, { theme: 'light' }).svg;
    expect(light).toBe(renderDocumentSvg(own, { theme: 'dark' }).svg);
    expect(light).toContain('#120c1f');
    expect(light).not.toContain(LIGHT.canvas);
  });

  it('wears the style’s arrowhead and line weight', () => {
    const own: DraftDocument = { ...base(), style: style({ connectors: { head: 'triangle', weight: 'bold' } }) };
    const svg = renderDocumentSvg(own, { theme: 'light' }).svg;
    expect(svg).toContain('M14 4 L0 0 L0 8 Z');
    expect(svg).toContain('stroke-width="2.4"');
    expect(renderDocumentSvg(base(), { theme: 'light' }).svg).not.toContain('M14 4 L0 0 L0 8 Z');
  });

  it('can be drawn in a style the diagram does not carry, for a preview', () => {
    const plain = base();
    const preview = resolveStyle(style({ hand: { base: 'sketch' } }));
    expect(renderDocumentSvg(plain, { theme: 'light', style: preview }).svg).toBe(renderDocumentSvg(plain, { theme: 'light', preset: 'sketch' }).svg);
  });
});
