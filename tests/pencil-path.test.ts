import { describe, expect, it } from 'vitest';
import { pencilPath } from '../src/render/roughness/pencilPath';
import { flattenPath } from '../src/edges/routing';

const routes = [
  'M10.12345 20.23456 L510.12345 20.23456',
  'M10.12345 20.23456 L10.12345 520.23456',
  'M0 0 L86 0 Q100 0 100 14 L100 186 Q100 200 114 200 L400 200',
  'M0 0 C200 0 200 200 400 200',
];

describe('Pencil Sketch stroke', () => {
  it.each(routes)('keeps exact endpoints and a deterministic, separate retrace for %s', d => {
    const main = pencilPath(d, 'e1:0');
    const retrace = pencilPath(d, 'e1:1');
    expect(main).toBe(pencilPath(d, 'e1:0', false));
    expect(main).not.toBe(retrace);
    const original = flattenPath(d);
    const drawn = flattenPath(main);
    expect(drawn[0]).toEqual(original[0]);
    expect(drawn.at(-1)).toEqual(original.at(-1));
  });

  it('has visible alternating drift along a long straight stroke, rather than one faint bow', () => {
    const points = flattenPath(pencilPath('M0 0 L500 0', 'e1:0'));
    expect(points.filter(p => p.y > 0.8).length).toBeGreaterThan(8);
    expect(points.filter(p => p.y < -0.8).length).toBeGreaterThan(8);
    expect(points.every(p => Math.abs(p.y) < 3)).toBe(true);
  });

  it('keeps short stubs and manual bend coordinates precise', () => {
    const d = 'M0 0 L20 0 Q30 0 30 10 L30 200';
    const drawn = pencilPath(d, 'manual:0');
    expect(drawn).toMatch(/^M0 0L20 0Q30 0 30 10/);
    expect(flattenPath(drawn).some(p => p.x === 30 && p.y === 10)).toBe(true);
  });

  it('bounds work and displacement on an exceptionally long line', () => {
    const d = pencilPath('M0 0 L1000000 0', 'long:0');
    expect(d.match(/C/g)!.length).toBe(64);
    expect(flattenPath(d).every(p => Math.abs(p.y) < 3)).toBe(true);
  });
});
