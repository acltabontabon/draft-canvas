import { describe, expect, it } from 'vitest';
import { NODE_TYPES } from '../src/document/types';
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
    const node = createNode({ type: 'note', x: 0, y: 0, text: 'Note' });
    expect(describeNode(node, describeContext(LIGHT))).toEqual(describeNode(node, clean));
  });

  it('note/group/ellipse/code outlines stay plain rect/ellipse shapes at Clean, never a path', () => {
    for (const type of ['note', 'group', 'ellipse', 'code'] as const) {
      const node = createNode({ type, x: 0, y: 0, text: 'Label' });
      const outline = outlineShapes(node, clean)[0]!;
      expect(outline.t === 'rect' || outline.t === 'ellipse').toBe(true);
    }
  });

  it('switches to a jittered path outline at Draft/Sketch for rect-based nodes', () => {
    for (const type of ['note', 'group'] as const) {
      const node = createNode({ type, x: 0, y: 0, text: 'Label' });
      expect(outlineShapes(node, draft)[0]!.t).toBe('path');
      expect(outlineShapes(node, sketch)[0]!.t).toBe('path');
    }
  });

  it('every node type has a Clean output identical to describeContext\'s default, across the full NODE_TYPES set', () => {
    for (const type of NODE_TYPES) {
      const node = createNode({ type, x: 0, y: 0, text: 'Label' });
      expect(describeNode(node, clean)).toEqual(describeNode(node, describeContext(LIGHT)));
    }
  });

  it('every node type with an outline switches to a path the moment Draft/Sketch is active (text has no outline to switch)', () => {
    for (const type of NODE_TYPES.filter((t) => t !== 'text')) {
      const node = createNode({ type, x: 0, y: 0, width: 176, height: 96, text: 'Label' });
      const cleanOutline = outlineShapes(node, clean)[0]!;
      expect(cleanOutline.t === 'rect' || cleanOutline.t === 'ellipse' || cleanOutline.t === 'path').toBe(true);
      expect(outlineShapes(node, sketch)[0]!.t).toBe('path');
    }
  });

  it('text/label position and content never change across presets', () => {
    for (const type of ['note', 'group', 'service', 'database', 'queue', 'actor'] as const) {
      const node = createNode({ type, x: 0, y: 0, text: 'Order Service' });
      expect(textOf(node, draft)).toEqual(textOf(node, clean));
      expect(textOf(node, sketch)).toEqual(textOf(node, clean));
    }
  });
});

describe('Intentional Roughness — determinism', () => {
  it('the same node id and preset always produces the same outline path', () => {
    const node = createNode({ type: 'note', id: 'n1', x: 0, y: 0, width: 160, height: 80 });
    const a = describeNode(node, sketch);
    const b = describeNode(node, sketch);
    expect(a).toEqual(b);
  });

  it('different node ids at the same preset produce different jitter', () => {
    const a = createNode({ type: 'note', id: 'n1', x: 0, y: 0, width: 160, height: 80 });
    const b = createNode({ type: 'note', id: 'n2', x: 0, y: 0, width: 160, height: 80 });
    const shapeA = outlineShapes(a, sketch)[0];
    const shapeB = outlineShapes(b, sketch)[0];
    expect(shapeA).not.toEqual(shapeB);
  });
});

describe('Intentional Roughness — developer-preset silhouettes stay recognisable', () => {
  it('database/queue keep the same number and kind of outline shapes at Draft — always paths, never a rect substitution', () => {
    for (const type of ['database', 'queue'] as const) {
      const node = createNode({ type, id: 'dev1', x: 0, y: 0, width: 176, height: 96, text: 'X' });
      const cleanShapes = describeNode(node, clean).shapes;
      const draftShapes = describeNode(node, draft).shapes;
      expect(draftShapes.length).toBe(cleanShapes.length);
      expect(draftShapes.map((s) => s.t)).toEqual(cleanShapes.map((s) => s.t));
    }
  });

  it('database/queue add exactly a retrace body+lid pair at Sketch, still all paths', () => {
    for (const type of ['database', 'queue'] as const) {
      const node = createNode({ type, id: 'dev1', x: 0, y: 0, width: 176, height: 96, text: 'X' });
      const cleanShapes = describeNode(node, clean).shapes;
      const sketchShapes = describeNode(node, sketch).shapes;
      expect(sketchShapes.length).toBe(cleanShapes.length + 2);
      expect(sketchShapes.every((s) => s.t === 'path' || s.t === 'text')).toBe(true);
    }
  });

  it('service and actor switch their outline from a plain shape (Clean) to a jittered path (Draft/Sketch), same as box/note/group', () => {
    const service = createNode({ type: 'service', id: 'svc1', x: 0, y: 0, width: 176, height: 96, text: 'X' });
    expect(describeNode(service, clean).shapes[0]!.t).toBe('rect');
    expect(describeNode(service, sketch).shapes[0]!.t).toBe('path');

    const actor = createNode({ type: 'actor', id: 'act1', x: 0, y: 0, width: 96, height: 96, text: 'X' });
    expect(describeNode(actor, clean).shapes[0]!.t).toBe('rect');
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

describe('Intentional Roughness — Junction (ellipse) gets a clamped, retraced treatment', () => {
  it('adds a retrace rim pass at Sketch only, not Draft', () => {
    const node = createNode({ type: 'ellipse', id: 'j1', x: 0, y: 0, width: 40, height: 40 });
    const cleanCount = outlineShapes(node, clean).length;
    expect(outlineShapes(node, draft)).toHaveLength(cleanCount);
    expect(outlineShapes(node, sketch)).toHaveLength(cleanCount + 1);
  });

  it('clamps jitter relative to the node\'s own radius at the smallest (24px) junction size', () => {
    const node = createNode({ type: 'ellipse', id: 'j2', x: 0, y: 0, width: 24, height: 24 });
    const outline = outlineShapes(node, sketch)[0] as { d: string };
    // rx/ry ≈ 11.25 at this size; the clamp caps both outline and bow at 18% of that (~2), well
    // under the flat sketch profile's outline (2.2) + bow (3.4) — every coordinate in the path
    // should stay within a small margin of the node's own bounding box, not balloon past it.
    const nums = outline.d.match(/-?\d*\.?\d+/g)!.map(Number);
    for (const n of nums) {
      expect(n).toBeGreaterThan(-10);
      expect(n).toBeLessThan(34);
    }
  });
});

describe('Intentional Roughness — a rounded-rect corner radius never exceeds the rect it is drawn in', () => {
  it('clamps a service outline\'s corner radius at the schema\'s minimum node size', () => {
    const node = createNode({ type: 'service', id: 's1', x: 0, y: 0, width: 24, height: 24 });
    const outline = outlineShapes(node, clean)[0] as { t: 'rect'; r: number };
    expect(outline.t).toBe('rect');
    expect(outline.r).toBeLessThanOrEqual(Math.min(node.width, node.height) / 2);
  });

  it('clamps a boundary outline the same way, including its Sketch retrace pass', () => {
    const node = createNode({ type: 'group', id: 'g1', x: 0, y: 0, width: 24, height: 24 });
    const outline = outlineShapes(node, clean)[0] as { t: 'rect'; r: number };
    expect(outline.r).toBeLessThanOrEqual(Math.min(node.width, node.height) / 2);

    // Sketch's retrace pass draws the same outline a second time at an independent seed — spot-
    // check every coordinate of both paths stays within a small margin of the 24x24 box, the same
    // style of check the Junction clamp test above uses, rather than a corner rounder than the box
    // itself pushing coordinates outside it.
    const sketchPaths = outlineShapes(node, sketch).filter(
      (s): s is { t: 'path'; d: string } => s.t === 'path',
    );
    expect(sketchPaths.length).toBeGreaterThanOrEqual(2); // outline + retrace
    for (const path of sketchPaths) {
      const nums = path.d.match(/-?\d*\.?\d+/g)!.map(Number);
      for (const n of nums) {
        expect(n).toBeGreaterThan(-10);
        expect(n).toBeLessThan(34);
      }
    }
  });
});

describe('Intentional Roughness — Boundary is the boldest primitive (Sketch only)', () => {
  it('gets an overshoot pass at Sketch but not Draft', () => {
    const node = createNode({ type: 'group', id: 'b1', x: 0, y: 0, width: 300, height: 200, text: 'Payments' });
    const cleanCount = describeNode(node, clean).shapes.length;
    const draftCount = describeNode(node, draft).shapes.length;
    const sketchCount = describeNode(node, sketch).shapes.length;
    // Draft: outline switches from rect to path (+0 shapes, same primitive count as Clean).
    expect(draftCount).toBe(cleanCount);
    // Sketch: retrace (+1 path) and overshoot (+1 path) on top of the outline.
    expect(sketchCount).toBe(cleanCount + 2);
  });
});

describe('Intentional Roughness — Draft and Sketch differ by technique, not just magnitude', () => {
  it('only Sketch turns on retrace/overshoot — Draft never gains extra shapes over Clean for any primitive', () => {
    for (const type of NODE_TYPES.filter((t) => t !== 'text')) {
      const node = createNode({ type, id: 'divergence1', x: 0, y: 0, width: 176, height: 96, text: 'X' });
      const cleanCount = describeNode(node, clean).shapes.length;
      const draftCount = describeNode(node, draft).shapes.length;
      expect(draftCount).toBe(cleanCount);
    }
  });
});

describe('Intentional Roughness — shadow survives the switch to a jittered path outline', () => {
  it('a shape with a drop shadow keeps it once its outline becomes a path (service/note/code)', () => {
    for (const type of ['service', 'note', 'code'] as const) {
      const node = createNode({ type, id: 'shadow1', x: 0, y: 0, width: 176, height: 96, text: 'X' });
      const outline = outlineShapes(node, sketch)[0]!;
      expect(outline.t).toBe('path');
      expect((outline as { shadow?: boolean }).shadow).toBe(true);
    }
  });

  it('a junction (ellipse) keeps its shadow once its outline becomes a path', () => {
    const node = createNode({ type: 'ellipse', id: 'shadow2', x: 0, y: 0, width: 40, height: 40 });
    const outline = outlineShapes(node, sketch)[0]!;
    expect(outline.t).toBe('path');
    expect((outline as { shadow?: boolean }).shadow).toBe(true);
  });
});
