import { describe, expect, it } from 'vitest';
import { depthGlyphPaths, depthMarkAccent, layerBehind } from '../src/canvas/insideMark';

describe('depth glyph', () => {
  it('is three exact layers in Clean and hand-drawn ones, stable per shape, in Sketch', () => {
    const clean = depthGlyphPaths('clean', 'n1').layers;
    expect(clean).toHaveLength(3);
    expect(clean[2]).toBe('M7 1.5 L12.75 4.5 L7 7.5 L1.25 4.5 L7 1.5');
    const sketch = depthGlyphPaths('sketch', 'n1').layers;
    expect(sketch).not.toEqual(clean);
    expect(depthGlyphPaths('sketch', 'n1').layers).toEqual(sketch);
  });

  it('draws the layer behind a shape as its outline and fill alone, never its words or shadow', () => {
    const layer = layerBehind([
      { t: 'rect', x: 0, y: 0, w: 10, h: 10, fill: '#000', shadow: true },
      { t: 'text', x: 0, y: 0, layout: { lines: [], width: 0, height: 0 } as never, font: {} as never, fill: '#fff', align: 'middle' },
      { t: 'group', children: [{ t: 'path', d: 'M0 0', stroke: { color: '#fff', width: 1 } }] },
    ]);
    expect(layer).toHaveLength(2);
    expect(layer[0]).toMatchObject({ t: 'rect', shadow: false });
    expect(layer[1]).toMatchObject({ t: 'group' });
  });

  it("takes the shape's own colour, including the colour it is drawn in by default", () => {
    expect(depthMarkAccent({ type: 'service' })).toBe('teal');
    expect(depthMarkAccent({ type: 'database' })).toBe('blue');
    expect(depthMarkAccent({ type: 'queue' })).toBe('violet');
    expect(depthMarkAccent({ type: 'component' })).toBe('neutral');
    expect(depthMarkAccent({ type: 'service', accent: 'rose' })).toBe('rose');
  });
});
