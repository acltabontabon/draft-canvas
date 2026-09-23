import { describe, expect, it } from 'vitest';
import { badgeCrowds, badgePoint } from '../src/edges/badgePoint';
import { routeBetween } from '../src/edges/routing';

const rect = (x: number, y: number) => ({ x, y, width: 160, height: 80 });

describe('badgePoint', () => {
  it('sits on a straight connector, not off to the side of it', () => {
    const route = routeBetween(rect(0, 0), rect(400, 200), 'straight');
    const at = badgePoint(route, 'straight');
    const dx = route.target.x - route.source.x;
    const dy = route.target.y - route.source.y;
    // Collinear with the drawn line: the cross product of (line, badge - source) is zero.
    const cross = dx * (at.y - route.source.y) - dy * (at.x - route.source.x);
    expect(Math.abs(cross)).toBeLessThan(1e-6);
    expect(at.x).toBeGreaterThan(route.source.x);
    expect(at.x).toBeLessThan(route.target.x);
  });

  it('walks out along the source side\'s normal for an orthogonal connector', () => {
    const route = routeBetween(rect(0, 0), rect(400, 0), 'smoothstep');
    const at = badgePoint(route, 'smoothstep');
    expect(at.y).toBeCloseTo(route.source.y);
    expect(Math.abs(at.x - route.source.x)).toBeCloseTo(22);
  });
});

/**
 * The predicate that replaced "is this connector a numbered step?" as the reason to drop its
 * caption. The coarse version cost every member of a presented flow its words — see
 * `badgeCrowds`'s own comment.
 */
describe('badgeCrowds', () => {
  it('leaves a caption alone on a connector long enough to hold both', () => {
    const route = routeBetween(rect(0, 0), rect(600, 0), 'smoothstep');
    const at = badgePoint(route, 'smoothstep');
    expect(badgeCrowds(at, { x: route.labelX, y: route.labelY })).toBe(false);
  });

  it('reports the badge sitting on the label point of a short stacked connector', () => {
    // Two shapes stacked close together: the badge's fixed 22-unit walk out of the source lands
    // on the very point the caption is drawn at. This is an ordinary shape, not a contrived one —
    // which is why the caption has to be dropped here and nowhere wider.
    const route = routeBetween(rect(0, 0), rect(0, 130), 'smoothstep');
    const at = badgePoint(route, 'smoothstep');
    expect(Math.hypot(at.x - route.labelX, at.y - route.labelY)).toBeLessThan(1);
    expect(badgeCrowds(at, { x: route.labelX, y: route.labelY })).toBe(true);
  });
});
