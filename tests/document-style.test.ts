/**
 * A diagram's own style as the file holds it: safe to read from anywhere, the same bytes every
 * time, root-only, one undo step, and absent from every diagram nobody has styled.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { embed, viewOf } from '../src/depth/tree';
import { createDocument, createNode, cloneDocumentAsNew } from '../src/document/factory';
import { addNodes, setStyle } from '../src/document/operations';
import {
  STYLE_KINDS,
  STYLE_LIMITS,
  STYLE_SHAPE_KEYS,
  artSlotOf,
  canonicalStyle,
  normalizeAsset,
  normalizeStyle,
  pathCommands,
  shapeKindOf,
  withoutAssets,
  type DocumentStyle,
  type StyleAsset,
} from '../src/document/style';
import { CURRENT_VERSION, NODE_TYPES, type DraftDocument } from '../src/document/types';
import { parseDocument } from '../src/document/validate';
import { serializeDocument } from '../src/export/project';
import { __resetInteraction, fileOf, useEditorStore } from '../src/store/editorStore';

const ART: StyleAsset = { id: 'a1b2c3d4e5', w: 24, h: 24, paths: [{ d: 'M2 2L22 2L22 22C12 26 6 20 2 22Z', fill: 'fill', stroke: 'line', sw: 1.5 }] };

const STYLE: DocumentStyle = {
  v: 1,
  name: 'Harbour',
  hand: { base: 'sketch', wobble: 'calm' },
  general: { weight: 'bold', corners: 'round' },
  schemes: { light: { canvas: '#f6e7c8', text: '#3a2a1a', accents: { teal: { fill: '#e9f3ef', line: '#2f6f66', text: '#17443e', chip: '#2f6f66' } } } },
  shapes: { 'service:gateway': { shadow: false }, database: { art: ART.id, fit: 'contain' } },
  connectors: { weight: 'fine', head: 'triangle', colour: 'plain' },
  assets: [ART],
};

const styled = (style: DocumentStyle = STYLE): DraftDocument => ({ ...createDocument('Styled'), style });

function reopened(document: DraftDocument) {
  const result = parseDocument(serializeDocument(document));
  if (!result.ok) throw new Error(result.error);
  return result;
}

describe('the shapes a style can name', () => {
  it('are every type and every kind of it, so a style can cover them all', () => {
    for (const type of NODE_TYPES) {
      expect(STYLE_SHAPE_KEYS).toContain(type);
      for (const kind of STYLE_KINDS[type]) expect(STYLE_SHAPE_KEYS).toContain(`${type}:${kind}`);
    }
    expect(new Set(STYLE_SHAPE_KEYS).size).toBe(STYLE_SHAPE_KEYS.length);
  });

  it('read a shape with no kind of its own as the first kind of its type', () => {
    for (const type of NODE_TYPES) {
      const kind = shapeKindOf(createNode({ type, x: 0, y: 0 }));
      expect(kind, type).toBe(STYLE_KINDS[type][0]);
    }
    expect(shapeKindOf(createNode({ type: 'service', x: 0, y: 0, serviceKind: 'gateway' }))).toBe('gateway');
  });

  it('take a drawing only where a drawing cannot cover what the shape holds', () => {
    for (const type of ['text', 'note', 'code', 'sequence', 'group'] as const) {
      for (const kind of [undefined, ...STYLE_KINDS[type]]) expect(artSlotOf(type, kind), `${type}:${kind}`).toBeNull();
    }
    expect(artSlotOf('database', 'cache')).toBe('glyph');
    expect(artSlotOf('service', 'generic')).toBe('body');
    expect(artSlotOf('service', 'gateway')).toBe('glyph');
    expect(artSlotOf('component', 'generic')).toBe('body');
    expect(artSlotOf('component', 'port')).toBe('glyph');
    expect(artSlotOf('queue', 'topic')).toBe('body');
  });
});

describe('a style from anywhere', () => {
  it('is kept as it is when it is already sound', () => {
    const { style, repairs } = normalizeStyle(STYLE);
    expect(style).toEqual(STYLE);
    expect(repairs).toEqual([]);
  });

  it('is no style at all when absent, and says so when it cannot be read', () => {
    expect(normalizeStyle(undefined)).toEqual({ style: undefined, repairs: [] });
    for (const bad of [42, 'sketch', [], { v: 2, hand: { base: 'clean' } }, { hand: { base: 'clean' } }]) {
      const result = normalizeStyle(bad);
      expect(result.style).toBeUndefined();
      expect(result.repairs).toHaveLength(1);
    }
  });

  it('drops what it does not know and falls back where a value is wrong', () => {
    const { style, repairs } = normalizeStyle({
      v: 1,
      name: '  Mine\u0000  ',
      hand: { base: 'scribble', wobble: 'wild', retrace: 'yes' },
      general: { weight: 'huge', corners: 'sharp', shadow: 'no', face: 'comic', glow: true },
      shapes: { service: { weight: 'fine', onclick: 'alert(1)' }, 'service:teapot': { weight: 'bold' }, rocket: { weight: 'bold' }, note: { art: ART.id } },
      connectors: { head: 'heart', colour: 'plain', dash: [4, 4] },
      script: '<script>alert(1)</script>',
    });
    expect(style).toEqual({
      v: 1,
      name: 'Mine',
      hand: { base: 'clean' },
      general: { corners: 'sharp' },
      shapes: { service: { weight: 'fine' } },
      connectors: { colour: 'plain' },
    });
    expect(repairs).toEqual(['Ignored the look of 2 shape kind(s) this version does not know.']);
  });

  it('keeps a scheme colour only as six lowercase hex digits, and an accent only whole', () => {
    const { style } = normalizeStyle({
      v: 1,
      hand: { base: 'clean' },
      schemes: {
        light: { canvas: '#F6E7C8', text: 'red', grid: 'url(https://example.test/x)', accents: { teal: { fill: '#ffffff', line: '#000000', text: '#000000' }, blue: { fill: '#FFFFFF', line: '#112233', text: '#000000', chip: '#112233' } } },
        dark: { text: 'javascript:alert(1)' },
      },
    });
    expect(style?.schemes).toEqual({ light: { canvas: '#f6e7c8', accents: { blue: { fill: '#ffffff', line: '#112233', text: '#000000', chip: '#112233' } } } });
  });

  it('writes its keys in one order however the object was put together', () => {
    const shuffled = {
      assets: STYLE.assets,
      connectors: { colour: 'plain', head: 'triangle', weight: 'fine' },
      shapes: { 'service:gateway': { shadow: false }, database: { fit: 'contain', art: ART.id } },
      schemes: STYLE.schemes,
      general: { corners: 'round', weight: 'bold' },
      hand: { wobble: 'calm', base: 'sketch' },
      name: 'Harbour',
      v: 1,
    };
    expect(JSON.stringify(normalizeStyle(shuffled).style)).toBe(JSON.stringify(STYLE));
    expect(canonicalStyle(STYLE)).toBe(canonicalStyle(STYLE));
  });
});

describe('a drawing in a style', () => {
  it('is path data of four commands and short numbers, and nothing else', () => {
    expect(pathCommands('M0 0L10 0C1 2 3 4 5 6Z')).toBe(4);
    expect(pathCommands('M-12.5 0.25L1000 2000Z')).toBe(3);
    for (const bad of [
      '',
      'L0 0',
      'M0 0 L10 0',
      'M0,0L10,0',
      'm0 0l10 0',
      'M0 0H10',
      'M0 0A5 5 0 0 1 10 10',
      'M0 0L10',
      'M0 0L1e3 0',
      'M0 0L0.123 0',
      'M0 0L99999 0',
      'M0 0L2001 0',
      'M0 0L-1001 0',
      'M0 0Z0',
      'M0 0L10 0"/><script>alert(1)</script>',
      'M0 0L10 0 url(#x)',
    ]) {
      expect(pathCommands(bad), bad).toBeNull();
    }
  });

  it('is kept whole or not at all', () => {
    expect(normalizeAsset(ART)).toEqual(ART);
    const broken: unknown[] = [
      { ...ART, id: 'nope' },
      { ...ART, id: '../../etc' },
      { ...ART, w: 0 },
      { ...ART, h: 5000 },
      { ...ART, paths: [] },
      { ...ART, paths: [{ d: 'M0 0L1 1Z' }] },
      { ...ART, paths: [{ d: 'M0 0L1 1Z', fill: 'url(#gradient)' }] },
      { ...ART, paths: [{ d: 'M0 0L1 1Z', fill: 'expression(alert(1))' }] },
      { ...ART, paths: [...ART.paths, { d: 'M0 0<image href="https://example.test/x"/>', fill: 'line' }] },
      { ...ART, paths: Array.from({ length: STYLE_LIMITS.maxAssetPaths + 1 }, () => ({ d: 'M0 0L1 1Z', fill: 'line' })) },
      { ...ART, paths: [{ d: `M0 0${'L1 1'.repeat(STYLE_LIMITS.maxAssetChars)}`, fill: 'line' }] },
    ];
    for (const candidate of broken) expect(normalizeAsset(candidate)).toBeNull();
  });

  it('may be painted by a role, a named colour or a literal one', () => {
    const paints = ['fill', 'line', 'text', 'chip', 'canvas', 'amber:fill', 'rose:chip', '#AABBCC'];
    const asset = normalizeAsset({ ...ART, paths: paints.map((fill) => ({ d: 'M0 0L1 1Z', fill })) });
    expect(asset?.paths.map((path) => path.fill)).toEqual(['fill', 'line', 'text', 'chip', 'canvas', 'amber:fill', 'rose:chip', '#aabbcc']);
    expect(normalizeAsset({ ...ART, paths: [{ d: 'M0 0L1 1Z', fill: 'mauve:fill' }] })).toBeNull();
  });

  it('is dropped with its style when nothing uses it, and a shape forgets one that is not there', () => {
    const spare: StyleAsset = { ...ART, id: 'a000000000' };
    const { style } = normalizeStyle({ ...STYLE, shapes: { database: { art: ART.id }, queue: { art: 'a999999999', fit: 'contain' } }, assets: [ART, spare] });
    expect(style?.assets).toEqual([ART]);
    expect(style?.shapes).toEqual({ database: { art: ART.id } });
    expect(normalizeStyle(withoutAssets(STYLE)).style?.shapes).toEqual({ 'service:gateway': { shadow: false } });
  });

  it('is counted against what one style may carry', () => {
    const d = `M0 0${'L10 10'.repeat(1300)}`;
    const assets = Array.from({ length: STYLE_LIMITS.maxAssets + 6 }, (_, index) => ({ id: `a${String(index).padStart(9, '0')}`, w: 24, h: 24, paths: [{ d, fill: 'line' }] }));
    const shapes = Object.fromEntries(STYLE_SHAPE_KEYS.filter((key) => artSlotOf(key.split(':')[0] as never, key.split(':')[1]) !== null).map((key, index) => [key, { art: assets[index % assets.length]!.id }]));
    const { style, repairs } = normalizeStyle({ v: 1, hand: { base: 'clean' }, shapes, assets });
    const kept = style?.assets ?? [];
    expect(kept.length).toBeLessThanOrEqual(STYLE_LIMITS.maxAssets);
    expect(kept.reduce((sum, asset) => sum + asset.paths[0]!.d.length, 0)).toBeLessThanOrEqual(STYLE_LIMITS.maxAssetsChars);
    expect(repairs.some((repair) => repair.includes('custom drawing'))).toBe(true);
  });

  it('counts only what something draws, so replacing a drawing near the limit keeps the new one', () => {
    // The old drawing, about to be unused, once took the room the new one needed: both were lost.
    const d = `M0 0${'L10 10'.repeat(1300)}`;
    const big = (id: string) => ({ id, w: 24, h: 24, paths: [{ d, fill: 'line' as const }] });
    const slots = STYLE_SHAPE_KEYS.filter((key) => key !== 'database' && artSlotOf(key.split(':')[0] as never, key.split(':')[1]) !== null);
    const room = Math.floor(STYLE_LIMITS.maxAssetsChars / d.length) - 1;
    expect(slots.length).toBeGreaterThanOrEqual(room);
    const others = slots.slice(0, room).map((key, index) => [key, big(`a${String(index).padStart(9, '0')}`)] as const);
    const old = big('a000000old');
    const replacement = big('a000000new');
    const shapes = { ...Object.fromEntries(others.map(([key, asset]) => [key, { art: asset.id }])), database: { art: replacement.id } };
    const { style } = normalizeStyle({ v: 1, hand: { base: 'clean' }, shapes, assets: [...others.map(([, asset]) => asset), old, replacement] });
    expect(style?.shapes?.database?.art).toBe(replacement.id);
    expect(style?.assets?.some((asset) => asset.id === old.id)).toBe(false);
  });
});

describe('a styled diagram as a file', () => {
  it('comes back as it was saved, and saves to the same bytes again', () => {
    const document = styled();
    const first = serializeDocument(document);
    const result = reopened(document);
    expect(result.document.style).toEqual(STYLE);
    expect(result.repairs).toEqual([]);
    expect(serializeDocument(result.document)).toBe(first);
  });

  it('leaves a diagram nobody styled exactly the bytes it always was', () => {
    const plain = createDocument('Plain');
    expect(serializeDocument(plain)).not.toContain('"style"');
    expect('style' in reopened(plain).document).toBe(false);
  });

  it('opens a file from before styles with none, so it still follows the device', () => {
    const old = JSON.parse(serializeDocument(createDocument('Old')));
    const result = parseDocument({ ...old, version: CURRENT_VERSION - 1 });
    expect(result.ok && result.document.version).toBe(CURRENT_VERSION);
    expect(result.ok && 'style' in result.document).toBe(false);
  });

  it('reads a style at the root only, never from a room', () => {
    const owner = createNode({ id: 'owner', type: 'service', x: 0, y: 0, text: 'Owner' });
    const inner = createNode({ id: 'inner', type: 'service', x: 0, y: 0, text: 'Inner' });
    const raw = JSON.parse(serializeDocument({ ...styled(), nodes: [{ ...owner, inside: { nodes: [inner], edges: [], flows: [], viewport: { x: 0, y: 0, zoom: 1 } } }] }));
    raw.nodes[0].inside.style = { v: 1, hand: { base: 'draft' } };
    const result = parseDocument(raw);
    expect(result.ok && result.document.style).toEqual(STYLE);
    expect(result.ok && JSON.stringify(result.document.nodes[0]!.inside)).not.toContain('draft');
  });

  it('goes with a duplicate', () => {
    expect(cloneDocumentAsNew(styled(), 'Copy').style).toEqual(STYLE);
  });
});

describe('giving a diagram a style', () => {
  it('holds it to the rules a file is read by, and changes nothing when it is the same style', () => {
    const plain = createDocument('Doc');
    const once = setStyle(plain, { ...STYLE, general: { corners: 'round', weight: 'bold' } });
    expect(once.style).toEqual(STYLE);
    expect(setStyle(once, structuredClone(STYLE))).toBe(once);
    expect(setStyle(plain, undefined)).toBe(plain);
    const bare = setStyle(once, undefined);
    expect('style' in bare).toBe(false);
  });

  it('reaches the file from inside a room, and leaves it from there too', () => {
    const owner = createNode({ id: 'owner', type: 'service', x: 0, y: 0, text: 'Owner' });
    const inner = createNode({ id: 'inner', type: 'service', x: 0, y: 0, text: 'Inner' });
    const file: DraftDocument = { ...createDocument('Rooms'), nodes: [{ ...owner, inside: { nodes: [inner], edges: [], flows: [], viewport: { x: 0, y: 0, zoom: 1 } } }] };
    const room = viewOf(file, [owner.id])!;
    const home = embed(file, [owner.id], setStyle(room, STYLE));
    expect(home.style).toEqual(STYLE);
    // The room sees the file's style: one diagram, one look.
    expect(viewOf(home, [owner.id])!.style).toEqual(STYLE);
    const cleared = embed(home, [owner.id], setStyle(viewOf(home, [owner.id])!, undefined));
    expect('style' in cleared).toBe(false);
  });
});

describe('in the editor', () => {
  const store = useEditorStore;
  beforeEach(() => {
    __resetInteraction();
    store.setState({
      document: addNodes(createDocument('Editor'), [createNode({ id: 'n', type: 'service', x: 0, y: 0, text: 'A' })]),
      path: [],
      outer: null,
      liveViewport: null,
      history: { past: [], future: [] },
      selection: { nodes: [], edges: [] },
      clipboard: null,
      revision: 0,
    });
  });

  it('is one undo step, and applying the same style again is none', () => {
    store.getState().setDocumentStyle(STYLE);
    expect(fileOf(store.getState()).style).toEqual(STYLE);
    expect(store.getState().history.past).toHaveLength(1);
    store.getState().setDocumentStyle(structuredClone(STYLE));
    expect(store.getState().history.past).toHaveLength(1);
    store.getState().undo();
    expect('style' in fileOf(store.getState())).toBe(false);
    store.getState().redo();
    expect(fileOf(store.getState()).style).toEqual(STYLE);
  });
});
