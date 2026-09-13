import { describe, expect, it } from 'vitest';
import { fitWithin, MAX_BACKGROUND_SIDE } from '../src/lib/backgroundImage';

describe('background image sizing', () => {
  it('leaves an image that already fits alone', () => {
    expect(fitWithin(1920, 1080, MAX_BACKGROUND_SIDE)).toEqual({ width: 1920, height: 1080 });
    expect(fitWithin(4096, 10, MAX_BACKGROUND_SIDE)).toEqual({ width: 4096, height: 10 });
  });

  it('scales the longest side down to the cap, keeping the aspect ratio', () => {
    expect(fitWithin(8192, 6144, MAX_BACKGROUND_SIDE)).toEqual({ width: 4096, height: 3072 });
    expect(fitWithin(3000, 12000, MAX_BACKGROUND_SIDE)).toEqual({ width: 1024, height: 4096 });
    expect(fitWithin(100000, 1, MAX_BACKGROUND_SIDE)).toEqual({ width: 4096, height: 1 });
  });
});
