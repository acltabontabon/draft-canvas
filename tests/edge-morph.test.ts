import { describe, expect, it } from 'vitest';
import { MORPH_SAMPLES, morphPath, morphTravel, resample, samplesOf, worthMorphing } from '../src/edges/morph';

describe('a route easing into another', () => {
  it('reads a path as evenly spaced points that keep its ends', () => {
    const points = resample([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], 5);
    expect(points).toEqual([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 100, y: 100 }]);
    expect(samplesOf('M0 0 L100 0')).toHaveLength(MORPH_SAMPLES);
  });

  it('has nothing to say about a path with no length, or one the router never draws', () => {
    expect(resample([{ x: 4, y: 4 }, { x: 4, y: 4 }])).toEqual([]);
    expect(samplesOf('M0 0 A5 5 0 0 1 10 10')).toEqual([]);
    expect(worthMorphing([], [])).toBe(false);
  });

  it('starts on the old route and ends on the new one', () => {
    const from = samplesOf('M0 0 L100 0', 3);
    const to = samplesOf('M0 40 L100 40', 3);
    expect(morphPath(from, to, 0)).toBe('M0 0L50 0L100 0');
    expect(morphPath(from, to, 1)).toBe('M0 40L50 40L100 40');
    expect(morphPath(from, to, 0.5)).toBe('M0 20L50 20L100 20');
    expect(morphTravel(from, to)).toBe(40);
  });

  it('plays a line settling, never a twitch and never a leap across the diagram', () => {
    const at = (y: number) => samplesOf(`M0 ${y} L100 ${y}`);
    expect(worthMorphing(at(0), at(40))).toBe(true);
    expect(worthMorphing(at(0), at(1))).toBe(false);
    expect(worthMorphing(at(0), at(5000))).toBe(false);
  });
});
