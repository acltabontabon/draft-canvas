import { describe, expect, it } from 'vitest';
import { createNode } from '../src/document/factory';
import { describeContext, describeNode } from '../src/nodes/describe';
import { LIGHT } from '../src/render/theme/tokens';

const clean = describeContext(LIGHT);
const draft = describeContext(LIGHT, 'draft');
const sketch = describeContext(LIGHT, 'sketch');

function outlineShapes(node: ReturnType<typeof createNode>, ctx: typeof clean) {
  return describeNode(node, ctx).shapes.filter((s) => s.t === 'rect' || s.t === 'path' || s.t === 'ellipse');
}

function textOf(node: ReturnType<typeof createNode>, ctx: typeof clean) {
  return describeNode(node, ctx)
    .shapes.filter((s): s is Extract<typeof s, { t: 'text' }> => s.t === 'text')
    .map((s) => ({ x: s.x, y: s.y, lines: s.layout.lines.map((l) => l.text) }));
}

describe('Intentional Roughness — Clean stays byte-for-byte unchanged', () => {
  it('describeContext defaults to clean, matching an explicit clean preset', () => {
    const node = createNode({ type: 'card', x: 0, y: 0, text: 'Card' });
    expect(describeNode(node, describeContext(LIGHT))).toEqual(describeNode(node, clean));
  });

  it('box/note/group/ellipse/code outlines stay plain rect/ellipse shapes at Clean, never a path', () => {
    for (const type of ['card', 'rounded', 'note', 'group', 'ellipse', 'code'] as const) {
      const node = createNode({ type, x: 0, y: 0, text: 'Label' });
      const outline = outlineShapes(node, clean)[0]!;
      expect(outline.t === 'rect' || outline.t === 'ellipse').toBe(true);
    }
  });

  it('switches to a jittered path outline at Draft/Sketch for rect-based nodes', () => {
    for (const type of ['card', 'note', 'group'] as const) {
      const node = createNode({ type, x: 0, y: 0, text: 'Label' });
      expect(outlineShapes(node, draft)[0]!.t).toBe('path');
      expect(outlineShapes(node, sketch)[0]!.t).toBe('path');
    }
  });

  it('text/label position and content never change across presets', () => {
    for (const type of ['card', 'note', 'group', 'service', 'database', 'queue', 'actor'] as const) {
      const node = createNode({ type, x: 0, y: 0, text: 'Order Service' });
      expect(textOf(node, draft)).toEqual(textOf(node, clean));
      expect(textOf(node, sketch)).toEqual(textOf(node, clean));
    }
  });
});

describe('Intentional Roughness — determinism', () => {
  it('the same node id and preset always produces the same outline path', () => {
    const node = createNode({ type: 'card', id: 'n1', x: 0, y: 0, width: 160, height: 80 });
    const a = describeNode(node, sketch);
    const b = describeNode(node, sketch);
    expect(a).toEqual(b);
  });

  it('different node ids at the same preset produce different jitter', () => {
    const a = createNode({ type: 'card', id: 'n1', x: 0, y: 0, width: 160, height: 80 });
    const b = createNode({ type: 'card', id: 'n2', x: 0, y: 0, width: 160, height: 80 });
    const shapeA = outlineShapes(a, sketch)[0];
    const shapeB = outlineShapes(b, sketch)[0];
    expect(shapeA).not.toEqual(shapeB);
  });
});

describe('Intentional Roughness — developer-preset silhouettes stay recognisable', () => {
  it('database/queue keep the same number and kind of outline shapes across presets — always paths, never a rect substitution', () => {
    for (const type of ['database', 'queue'] as const) {
      const node = createNode({ type, id: 'dev1', x: 0, y: 0, width: 176, height: 96, text: 'X' });
      const cleanShapes = describeNode(node, clean).shapes;
      const sketchShapes = describeNode(node, sketch).shapes;
      expect(sketchShapes.length).toBe(cleanShapes.length);
      expect(sketchShapes.map((s) => s.t)).toEqual(cleanShapes.map((s) => s.t));
    }
  });

  it('service and actor switch their outline from a plain shape (Clean) to a jittered path (Draft/Sketch), same as box/note/group', () => {
    const service = createNode({ type: 'service', id: 'svc1', x: 0, y: 0, width: 176, height: 96, text: 'X' });
    expect(describeNode(service, clean).shapes[0]!.t).toBe('rect');
    expect(describeNode(service, sketch).shapes[0]!.t).toBe('path');

    const actor = createNode({ type: 'actor', id: 'act1', x: 0, y: 0, width: 96, height: 96, text: 'X' });
    expect(describeNode(actor, clean).shapes[0]!.t).toBe('ellipse');
    expect(describeNode(actor, sketch).shapes[0]!.t).toBe('path');
  });

  it('sketch outline paths differ from clean for every developer preset', () => {
    for (const type of ['database', 'queue', 'actor'] as const) {
      const node = createNode({ type, id: 'dev2', x: 0, y: 0, width: 176, height: 96, text: 'X' });
      const cleanD = describeNode(node, clean).shapes.find((s) => s.t === 'path') as { d: string } | undefined;
      const sketchD = describeNode(node, sketch).shapes.find((s) => s.t === 'path') as { d: string } | undefined;
      expect(cleanD).toBeDefined();
      expect(sketchD).toBeDefined();
      expect(sketchD!.d).not.toBe(cleanD!.d);
    }
  });
});
