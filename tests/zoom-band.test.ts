import { describe, expect, it } from 'vitest';
import { zoomBand } from '../src/canvas/zoomBand';

describe('semantic zoom', () => {
  it('shows everything at a reading zoom, and steps the small print back as the view pulls out', () => {
    expect(zoomBand(1)).toBeNull();
    expect(zoomBand(0.55)).toBeNull();
    expect(zoomBand(0.4)).toBe('far');
    expect(zoomBand(0.3)).toBe('far');
    expect(zoomBand(0.25)).toBe('overview');
    expect(zoomBand(0.1)).toBe('overview');
  });
});
