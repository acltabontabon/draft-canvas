import { describe, expect, it } from 'vitest';
import { roughEllipsePath, roughRectOvershootPath, roughRectPath } from '../src/render/roughness/roughRect';
import { roughenPath } from '../src/render/roughness/roughPath';
import { sketchArrowPath } from '../src/render/roughness/roughArrow';

describe('roughRectPath — bow is a second, independent axis from corner jitter', () => {
  it('bow 0 stays a pure function of corner amplitude (no behaviour change from before bow existed)', () => {
    const a = roughRectPath(0, 0, 100, 60, 8, 'n1', 2);
    const b = roughRectPath(0, 0, 100, 60, 8, 'n1', 2, 0);
    expect(a).toBe(b);
  });

  it('bow > 0 changes the path even when corner amplitude is 0', () => {
    const flat = roughRectPath(0, 0, 100, 60, 8, 'n1', 0, 0);
    const bowed = roughRectPath(0, 0, 100, 60, 8, 'n1', 0, 3);
    expect(bowed).not.toBe(flat);
  });

  it('is deterministic', () => {
    expect(roughRectPath(0, 0, 100, 60, 8, 'n1', 2, 3)).toBe(roughRectPath(0, 0, 100, 60, 8, 'n1', 2, 3));
  });
});

describe('roughRectOvershootPath — corner overshoot/undershoot pass', () => {
  it('is empty when the technique is off', () => {
    expect(roughRectOvershootPath(0, 0, 100, 60, 'n1', 2, 0)).toBe('');
  });

  it('produces four disconnected subpaths when active', () => {
    const d = roughRectOvershootPath(0, 0, 100, 60, 'n1', 2, 3);
    expect(d.match(/M/g)).toHaveLength(4);
    expect(d.match(/L/g)).toHaveLength(4);
  });

  it('is deterministic', () => {
    expect(roughRectOvershootPath(0, 0, 100, 60, 'n1', 2, 3)).toBe(
      roughRectOvershootPath(0, 0, 100, 60, 'n1', 2, 3),
    );
  });
});

describe('roughEllipsePath — bow perturbs control-point handles independent of rim points', () => {
  it('bow 0 matches calling without the parameter at all', () => {
    const a = roughEllipsePath(50, 30, 40, 20, 'n1', 2);
    const b = roughEllipsePath(50, 30, 40, 20, 'n1', 2, 0);
    expect(a).toBe(b);
  });

  it('bow > 0 changes the path', () => {
    const flat = roughEllipsePath(50, 30, 40, 20, 'n1', 2, 0);
    const bowed = roughEllipsePath(50, 30, 40, 20, 'n1', 2, 4);
    expect(bowed).not.toBe(flat);
  });
});

describe('roughenPath — bow fixes straight-routed connectors never wobbling', () => {
  const straight = 'M0,0L200,0';
  // roughenPath reformats (round + space-join) any time it doesn't take the amplitude===0 &&
  // bow===0 identity shortcut, even if no value actually changed — so these compare the parsed
  // numeric values, not the exact string.
  const nums = (d: string) => d.match(/-?\d*\.?\d+/g)!.map(Number);

  it('a bare two-point straight path has unchanged values under amplitude alone (the pre-existing gap)', () => {
    expect(nums(roughenPath(straight, 'e1', 3))).toEqual(nums(straight));
  });

  it('bow makes a straight-routed connector wobble for the first time', () => {
    const bowed = roughenPath(straight, 'e1', 0, 4);
    expect(nums(bowed)).not.toEqual(nums(straight));
    expect(nums(bowed).slice(0, 2)).toEqual([0, 0]);
  });

  it('bow never moves the path\'s first or last point', () => {
    const bowed = roughenPath(straight, 'e1', 3, 4);
    const values = nums(bowed);
    expect(values.slice(0, 2)).toEqual([0, 0]);
    expect(values.slice(-2)).toEqual([200, 0]);
  });

  it('leaves existing Q/C segments to the amplitude pass, not bow', () => {
    const curved = 'M0,0Q100,50 200,0';
    expect(nums(roughenPath(curved, 'e1', 0, 4))).toEqual(nums(curved));
  });

  it('is deterministic', () => {
    expect(roughenPath(straight, 'e1', 2, 3)).toBe(roughenPath(straight, 'e1', 2, 3));
  });
});

describe('sketchArrowPath — hand-drawn arrowhead', () => {
  const tip = { x: 100, y: 50 };
  const dir = { x: 1, y: 0 };

  it('never moves the tip, regardless of amplitude', () => {
    const d = sketchArrowPath(tip, dir, 'e1', 2);
    expect(d.startsWith('M100,50')).toBe(true);
  });

  it('the two wings differ from each other (asymmetric, not just narrower/wider)', () => {
    const d = sketchArrowPath(tip, dir, 'e1', 2);
    const points = d.match(/-?\d*\.?\d+,-?\d*\.?\d+/g)!;
    // [tip, wing1, wing2] — wing1 and wing2 should not be mirror-identical after jitter.
    expect(points[1]).not.toBe(points[2]);
  });

  it('is deterministic per edge id', () => {
    expect(sketchArrowPath(tip, dir, 'e1', 2)).toBe(sketchArrowPath(tip, dir, 'e1', 2));
  });

  it('different edge ids produce different wobble', () => {
    expect(sketchArrowPath(tip, dir, 'e1', 2)).not.toBe(sketchArrowPath(tip, dir, 'e2', 2));
  });

  it('open variant starts and ends on the wings, passing through the tip', () => {
    const d = sketchArrowPath(tip, dir, 'e1', 2, 'open');
    expect(d.startsWith('M')).toBe(true);
    expect(d).not.toContain('Z');
  });
});
