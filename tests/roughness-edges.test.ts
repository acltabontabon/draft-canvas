import { describe, expect, it } from 'vitest';
import { createEdge, createNode } from '../src/document/factory';
import { describeEdge, type EdgeDescribeContext } from '../src/edges/describe';
import { DARK } from '../src/render/theme/tokens';
import { StaticTextMeasurer } from '../src/render/text/measure';

const measurer = new StaticTextMeasurer();

function fixture() {
  const source = createNode({ type: 'service', x: 0, y: 0, width: 140, height: 60 });
  const target = createNode({ type: 'database', x: 400, y: 0, width: 140, height: 60 });
  const edge = createEdge({ source: source.id, target: target.id, label: 'ORDER_CREATED' });
  const nodes = new Map([[source.id, source], [target.id, target]]);
  return { edge, nodes };
}

function ctx(preset?: EdgeDescribeContext['preset']): EdgeDescribeContext {
  return { theme: DARK, measurer, showSequence: true, preset };
}

describe('Intentional Roughness — connectors never trade legibility for personality', () => {
  it('route, label position, and overlay shapes are identical across every preset', () => {
    const { edge, nodes } = fixture();
    const clean = describeEdge(edge, nodes, ctx('clean'))!;
    const draft = describeEdge(edge, nodes, ctx('draft'))!;
    const sketch = describeEdge(edge, nodes, ctx('sketch'))!;

    expect(draft.route).toEqual(clean.route);
    expect(sketch.route).toEqual(clean.route);
    expect(draft.overlay).toEqual(clean.overlay);
    expect(sketch.overlay).toEqual(clean.overlay);
    expect(draft.color).toBe(clean.color);
    expect(sketch.color).toBe(clean.color);
  });

  it('Clean is a single line, byte-identical to omitting the preset entirely', () => {
    const { edge, nodes } = fixture();
    const explicit = describeEdge(edge, nodes, ctx('clean'))!;
    const omitted = describeEdge(edge, nodes, ctx(undefined))!;
    expect(explicit).toEqual(omitted);
    expect(explicit.line).toHaveLength(1);
    expect(explicit.line[0]!.t).toBe('path');
    expect((explicit.line[0] as { d: string }).d).toContain('M');
  });

  it('Draft wobbles the line but stays a single stroke; Sketch adds a second, fainter one', () => {
    const { edge, nodes } = fixture();
    const clean = describeEdge(edge, nodes, ctx('clean'))!;
    const draft = describeEdge(edge, nodes, ctx('draft'))!;
    const sketch = describeEdge(edge, nodes, ctx('sketch'))!;

    expect(draft.line).toHaveLength(1);
    expect((draft.line[0] as { d: string }).d).not.toBe((clean.line[0] as { d: string }).d);

    expect(sketch.line).toHaveLength(2);
    expect((sketch.line[0] as { d: string }).d).not.toBe((clean.line[0] as { d: string }).d);
    expect((sketch.line[1] as { d: string }).d).not.toBe((sketch.line[0] as { d: string }).d);
  });

  it('never moves the line\'s start or end point — only the middle wobbles', () => {
    const { edge, nodes } = fixture();
    const clean = describeEdge(edge, nodes, ctx('clean'))!;
    const sketch = describeEdge(edge, nodes, ctx('sketch'))!;

    const firstPoint = (d: string) => d.match(/-?\d*\.?\d+/g)!.slice(0, 2).join(',');
    const lastPoint = (d: string) => d.match(/-?\d*\.?\d+/g)!.slice(-2).join(',');

    const cleanD = (clean.line[0] as { d: string }).d;
    const sketchD = (sketch.line[0] as { d: string }).d;
    expect(firstPoint(sketchD)).toBe(firstPoint(cleanD));
    expect(lastPoint(sketchD)).toBe(lastPoint(cleanD));
  });

  it('is deterministic: the same edge id and preset always produces the same wobble', () => {
    const { edge, nodes } = fixture();
    const a = describeEdge(edge, nodes, ctx('sketch'))!;
    const b = describeEdge(edge, nodes, ctx('sketch'))!;
    expect(a).toEqual(b);
  });
});
