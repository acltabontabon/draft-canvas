import { describe, expect, it } from 'vitest';
import { markerDefs } from '../src/render/svg/markers';
import { PERSONALITY_PROFILES } from '../src/render/roughness/presets';

describe('arrowhead marker viewports', () => {
  it('contains the entire head, including jitter and the open head’s round stroke', () => {
    for (const profile of Object.values(PERSONALITY_PROFILES)) {
      for (const color of ['#7c8492', '#6d7885', '#357a72']) {
        for (const marker of markerDefs([color], profile.arrowJitter)) {
          const [x, y, width, height] = String(marker.attrs!.viewBox).split(' ').map(Number) as [number, number, number, number];
          const path = marker.children![0]!;
          const stroke = Number(path.attrs!['stroke-width'] ?? 0) / 2;
          const points = String(path.attrs!.d).match(/-?\d*\.?\d+(?:e-?\d+)?/gi)!.map(Number);
          for (let i = 0; i < points.length; i += 2) {
            expect(points[i]! - stroke).toBeGreaterThanOrEqual(x);
            expect(points[i]! + stroke).toBeLessThanOrEqual(x + width);
            expect(points[i + 1]! - stroke).toBeGreaterThanOrEqual(y);
            expect(points[i + 1]! + stroke).toBeLessThanOrEqual(y + height);
          }
          // Expanding the viewport must not silently rescale the head as stroke widths change.
          expect(marker.attrs!.markerWidth).toBe(width);
          expect(marker.attrs!.markerHeight).toBe(height);
          expect(marker.attrs!.markerUnits).toBe('userSpaceOnUse');
        }
      }
    }
  });
});
