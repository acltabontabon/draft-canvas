import { describe, expect, it } from 'vitest';
import { createNode } from '../src/document/factory';
import { DATABASE_KINDS, NODE_TYPES, type DraftNodeType } from '../src/document/types';
import { EMPHASIS_STROKE_GAIN, emphasisColorOf, emphasisOf } from '../src/canvas/emphasis';
import { describeContext, describeNode } from '../src/nodes/describe';
import type { Shape } from '../src/render/displayList';
import { DARK, LIGHT } from '../src/render/theme/tokens';
import { PERSONALITY_PRESETS } from '../src/ui/personality/usePersonality';

const outlined = (shapes: readonly Shape[]): Extract<Shape, { stroke?: unknown }>[] =>
  shapes.flatMap((shape) => (shape.t === 'group' ? outlined(shape.children) : shape.t === 'text' || shape.t === 'code' ? [] : [shape]));

const words = (shapes: readonly Shape[]): Shape[] =>
  shapes.flatMap((shape) => (shape.t === 'group' ? words(shape.children) : shape.t === 'text' || shape.t === 'code' ? [shape] : []));

describe('presentation emphasis', () => {
  it('traces the filled bodies of a shape in their own line colour, heavier, with no fill, shadow or words', () => {
    const lit = emphasisOf([
      { t: 'rect', x: 0, y: 0, w: 10, h: 10, fill: '#000', shadow: true, stroke: { color: '#abc', width: 1.5 } },
      // A fill-only band (a service's cap) has no edge to light.
      { t: 'rect', x: 0, y: 0, w: 10, h: 2, fill: '#0f0' },
      // A stroke-only line (a cylinder's lid) is inside the body and stays dark.
      { t: 'path', d: 'M0 5 L10 5', fill: 'none', stroke: { color: '#abc', width: 1.5 } },
      { t: 'text', x: 0, y: 0, layout: { lines: [], width: 0, height: 0 } as never, font: {} as never, fill: '#fff', align: 'middle' },
    ]);
    expect(lit).toEqual([
      { t: 'rect', x: 0, y: 0, w: 10, h: 10, fill: 'none', shadow: false, stroke: { color: '#abc', width: 1.5 + EMPHASIS_STROKE_GAIN } },
    ]);
    expect(emphasisColorOf(lit)).toBe('#abc');
  });

  it('falls back to the stroked outline of a shape that has no filled body, skipping retrace passes', () => {
    const lit = emphasisOf([
      { t: 'rect', x: 0, y: 0, w: 10, h: 10, fill: '#000', opacity: 0.3 },
      { t: 'rect', x: 0, y: 0, w: 10, h: 10, fill: 'none', stroke: { color: '#abc', width: 1.25, dash: [6, 4] } },
      { t: 'path', d: 'M0 0 L10 0', fill: 'none', stroke: { color: '#abc', width: 1 }, opacity: 0.5 },
    ]);
    expect(lit).toHaveLength(1);
    expect(lit[0]).toMatchObject({ t: 'rect', fill: 'none', stroke: { width: 1.25 + EMPHASIS_STROKE_GAIN, dash: [6, 4] } });
  });

  it('keeps a scaled group and divides the gain by its scale, so a grown glyph is not lit heavier', () => {
    const lit = emphasisOf([
      {
        t: 'group',
        scale: 2,
        translate: { x: -10, y: 0 },
        children: [{ t: 'path', d: 'M0 0', fill: '#000', stroke: { color: '#abc', width: 0.75 } }],
      },
    ]);
    expect(lit).toEqual([
      {
        t: 'group',
        scale: 2,
        translate: { x: -10, y: 0 },
        children: [{ t: 'path', d: 'M0 0', fill: 'none', shadow: false, stroke: { color: '#abc', width: 0.75 + EMPHASIS_STROKE_GAIN / 2 } }],
      },
    ]);
  });

  const drawn = NODE_TYPES.filter((type) => type !== 'text');
  it.each(drawn)('lights a %s along its own drawn geometry, at every theme and personality', (type: DraftNodeType) => {
    for (const theme of [DARK, LIGHT]) {
      for (const preset of PERSONALITY_PRESETS) {
        const node = createNode({ type, x: 0, y: 0, text: 'Order DB' });
        const shapes = describeNode(node, describeContext(theme, preset)).shapes;
        const lit = emphasisOf(shapes);
        const outlines = outlined(lit);
        expect(outlines.length, `${type} ${theme.name} ${preset}`).toBeGreaterThan(0);
        expect(words(lit)).toHaveLength(0);
        for (const shape of outlines) {
          expect(shape.fill).toBe('none');
          expect(shape.stroke).toBeDefined();
          // Every lit outline is one of the shape's own: same path, same colour, only heavier.
          const own = outlined(shapes).find((s) => JSON.stringify({ ...s, fill: 0, shadow: 0, stroke: 0 }) === JSON.stringify({ ...shape, fill: 0, shadow: 0, stroke: 0 }));
          expect(own, `${type}: a lit outline that is not the shape's own`).toBeDefined();
          expect(shape.stroke!.color).toBe(own!.stroke!.color);
          expect(shape.stroke!.width).toBeGreaterThan(own!.stroke!.width);
        }
        expect(emphasisColorOf(lit)).toBe(outlines[0]!.stroke!.color);
      }
    }
  });

  it('lights a Data Store as its glyph alone — the cylinder, not a box around it and its label', () => {
    for (const databaseKind of DATABASE_KINDS) {
      const node = createNode({ type: 'database', x: 0, y: 0, text: 'Order DB', databaseKind });
      const shapes = describeNode(node, describeContext(LIGHT)).shapes;
      const lit = outlined(emphasisOf(shapes));
      // Every body the glyph is made of, and nothing that is only a line on it.
      const bodies = outlined(shapes).filter((s) => s.fill !== undefined && s.fill !== 'none' && s.stroke);
      expect(lit.map((s) => (s.t === 'path' ? s.d : s.t))).toEqual(bodies.map((s) => (s.t === 'path' ? s.d : s.t)));
      expect(lit.some((s) => s.t === 'rect' && s.w >= node.width - 2)).toBe(false);
    }
  });

  it('has nothing to light on a Text element, which is only words', () => {
    const node = createNode({ type: 'text', x: 0, y: 0, text: 'A caption' });
    expect(emphasisOf(describeNode(node, describeContext(LIGHT)).shapes)).toEqual([]);
  });
});
