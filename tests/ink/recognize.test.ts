import { describe, expect, it } from 'vitest';
import { CONVERT_CONFIDENCE, OFFER_CONFIDENCE, recognize, type InkGeometry } from '../../src/ink/recognize';
import type { Pt } from '../../src/ink/geometry';
import * as c from './corpus';

const at = (strokes: Pt[][], scale = 1) => recognize(strokes, { scale });

/** Converted as drawn: the right reading, confidently. */
function expectConverts(strokes: Pt[][], geometry: InkGeometry, scale = 1) {
  const result = at(strokes, scale);
  expect({ geometry: result.geometry, confident: result.confidence >= CONVERT_CONFIDENCE }, JSON.stringify(result.scores)).toEqual({ geometry, confident: true });
  return result;
}

/** Never converted on its own. */
function expectStaysInk(strokes: Pt[][], scale = 1) {
  const result = at(strokes, scale);
  expect(result.confidence < CONVERT_CONFIDENCE, `${result.geometry} ${result.confidence.toFixed(2)} ${JSON.stringify(result.scores)}`).toBe(true);
  return result;
}

describe('rectangles', () => {
  it('reads a clean rectangle', () => {
    expectConverts(c.rectangle(100, 100, 180, 90, c.hand(1, 0, 0)), 'rectangle');
  });

  it('reads uneven, hand-drawn rectangles across sizes and seeds', () => {
    for (let seed = 1; seed <= 30; seed += 1) {
      const r = c.rng(seed * 7);
      const w = 60 + r() * 300;
      const h = 40 + r() * 200;
      expectConverts(c.rectangle(50, 50, w, h, c.hand(seed, 2 + r() * 2.5, 0.8), { overshoot: r() * 8 }), 'rectangle');
    }
  });

  it('reads a slightly open rectangle', () => {
    for (let seed = 1; seed <= 10; seed += 1) {
      expectConverts(c.rectangle(0, 0, 200, 120, c.hand(seed, 2, 0.6), { gap: 14 }), 'rectangle');
    }
  });

  it('reads a rectangle with rounded corners', () => {
    expectConverts(c.rectangle(0, 0, 200, 120, c.hand(3, 1.5, 0.5), { radius: 14 }), 'rectangle');
  });

  it('reads a rectangle drawn as four lines, and as two corners', () => {
    for (let seed = 1; seed <= 10; seed += 1) {
      expectConverts(c.rectangleFourStrokes(0, 0, 220, 130, c.hand(seed, 2, 0.6)), 'rectangle');
      expectConverts(c.rectangleTwoStrokes(0, 0, 160, 100, c.hand(seed + 50, 2, 0.6)), 'rectangle');
    }
  });

  it('measures in screen pixels: the same box drawn zoomed out is still a box', () => {
    const strokes = c.rectangle(0, 0, 160, 90, c.hand(4, 2, 0.6));
    const zoomedOut = strokes.map((stroke) => stroke.map((p) => ({ x: p.x * 2.5, y: p.y * 2.5 })));
    const result = expectConverts(zoomedOut, 'rectangle', 0.4);
    expect(result.box.width).toBeGreaterThan(380);
  });

  it('does not read three sides as a box', () => {
    for (let seed = 1; seed <= 10; seed += 1) expectStaysInk(c.openBox(0, 0, 200, 120, c.hand(seed)));
  });

  it('reads a very large rectangle', () => {
    expectConverts(c.rectangle(0, 0, 1400, 900, c.hand(9, 6, 1.5)), 'rectangle');
  });

  it('leaves a very small drawing alone', () => {
    const result = at(c.rectangle(0, 0, 9, 7, c.hand(2, 0.3, 0.2)));
    expect(result.geometry).toBeNull();
  });
});

describe('ellipses', () => {
  it('reads circles and ovals', () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const r = c.rng(seed * 3);
      const rx = 30 + r() * 120;
      const ry = rx * (0.5 + r() * 0.5);
      expectConverts(c.ellipse(200, 200, rx, ry, c.hand(seed, 1.5 + r() * 1.5, 0.5)), 'ellipse');
    }
  });

  it('does not read an ellipse as a rectangle, nor a rectangle as an ellipse', () => {
    const oval = at(c.ellipse(100, 100, 90, 50, c.hand(5)));
    expect(oval.scores.rectangle ?? 0).toBeLessThan(0.2);
    const box = at(c.rectangle(0, 0, 180, 100, c.hand(5)));
    expect(box.scores.ellipse ?? 0).toBeLessThan(0.2);
  });

  it('leaves half a circle as ink', () => {
    expectStaysInk(c.ellipse(100, 100, 60, 60, c.hand(8), { sweep: Math.PI }));
  });
});

describe('lines and arrows', () => {
  it('reads straight and diagonal lines', () => {
    const line = expectConverts(c.line({ x: 0, y: 0 }, { x: 300, y: 4 }, c.hand(1, 1.5, 0.5)), 'line');
    expect(line.line?.heads).toBe('none');
    expectConverts(c.line({ x: 0, y: 0 }, { x: 200, y: 160 }, c.hand(2, 1.5, 0.5)), 'line');
  });

  it('reads an arrow drawn in one stroke, pointing where it was drawn to', () => {
    for (let seed = 1; seed <= 15; seed += 1) {
      const result = expectConverts(c.arrowOneStroke({ x: 0, y: 0 }, { x: 260, y: 30 }, c.hand(seed, 1.5, 0.5)), 'arrow');
      expect(result.line?.heads).toBe('end');
      expect(result.line!.to.x).toBeGreaterThan(result.line!.from.x);
    }
  });

  it('reads an arrowhead drawn as its own stroke', () => {
    for (let seed = 1; seed <= 15; seed += 1) {
      const result = expectConverts(c.arrowSeparateHead({ x: 300, y: 200 }, { x: 20, y: 40 }, c.hand(seed, 1.5, 0.5)), 'arrow');
      expect(result.line!.to.x).toBeLessThan(result.line!.from.x);
    }
  });

  it('reads a head drawn at the start of the line as pointing backwards', () => {
    const [shaft, head] = c.arrowSeparateHead({ x: 0, y: 0 }, { x: 240, y: 0 }, c.hand(3, 1, 0.4));
    const reversed = [shaft!.slice().reverse(), head!];
    const result = expectConverts(reversed, 'arrow');
    expect(result.line!.to.x).toBeGreaterThan(200);
  });

  it('accepts a half head', () => {
    expectConverts(c.arrowHalfHead({ x: 0, y: 0 }, { x: 220, y: 0 }, c.hand(4, 1.2, 0.4)), 'arrow');
  });

  it('does not read a short tick as a line', () => {
    expect(at(c.line({ x: 0, y: 0 }, { x: 14, y: 3 }, c.hand(1))).geometry).toBeNull();
  });
});

describe('cylinders, tubes and people', () => {
  it('reads a Data Store cylinder', () => {
    for (let seed = 1; seed <= 12; seed += 1) {
      const r = c.rng(seed);
      expectConverts(c.cylinder(0, 0, 90 + r() * 60, 110 + r() * 60, c.hand(seed, 1.5, 0.5)), 'cylinder');
    }
  });

  it('reads a tube on its side', () => {
    for (let seed = 1; seed <= 12; seed += 1) {
      expectConverts(c.tube(0, 0, 200, 60, c.hand(seed, 1.5, 0.5)), 'tube');
    }
  });

  it('reads a stick figure', () => {
    for (let seed = 1; seed <= 10; seed += 1) {
      expectConverts(c.stickFigure(100, 0, 150, c.hand(seed, 1.5, 0.5)), 'person');
    }
  });
});

describe('what stays ink', () => {
  it('never converts scribbles, zigzags, spirals, handwriting, ticks or triangles', () => {
    for (let seed = 1; seed <= 12; seed += 1) {
      expectStaysInk(c.scribble(0, 0, 200, 120, c.hand(seed, 2, 1)));
      expectStaysInk(c.zigzag(0, 0, 220, 60, c.hand(seed)));
      expectStaysInk(c.spiral(100, 100, 80, c.hand(seed)));
      expectStaysInk(c.handwriting(0, 0, 260, c.hand(seed)));
      expectStaysInk(c.checkmark(0, 0, 60, c.hand(seed)));
      expectStaysInk(c.triangle(0, 0, 160, 140, c.hand(seed)));
    }
  });

  it('never mistakes a very shaky box for anything else, and leaves an illegible one as ink', () => {
    for (let seed = 1; seed <= 8; seed += 1) {
      const shaky = at(c.rectangle(0, 0, 180, 110, c.hand(seed, 10, 4)));
      if (shaky.confidence >= CONVERT_CONFIDENCE) expect(shaky.geometry).toBe('rectangle');
      expectStaysInk(c.rectangle(0, 0, 180, 110, c.hand(seed, 30, 12)));
    }
  });

  it('is never confident about two unrelated marks drawn together', () => {
    const strokes = [...c.line({ x: 0, y: 0 }, { x: 100, y: 0 }, c.hand(1)), ...c.ellipse(300, 200, 30, 30, c.hand(2))];
    expectStaysInk(strokes);
  });

  it('offers, without converting, a box with a side half missing', () => {
    let offered = 0;
    for (let seed = 1; seed <= 10; seed += 1) {
      const result = at(c.rectangle(0, 0, 200, 120, c.hand(seed, 1.5, 0.5), { gap: 110 }));
      expect(result.confidence).toBeLessThan(CONVERT_CONFIDENCE);
      if (result.geometry === 'rectangle' && result.confidence >= OFFER_CONFIDENCE) offered += 1;
    }
    expect(offered).toBeGreaterThan(0);
  });
});

describe('cost', () => {
  it('reads a long multi-stroke drawing quickly', () => {
    const strokes = [...c.rectangleFourStrokes(0, 0, 900, 600, c.hand(1, 3, 1)), ...c.rectangle(0, 0, 900, 600, c.hand(2, 3, 1))];
    const start = performance.now();
    for (let i = 0; i < 20; i += 1) at(strokes);
    expect((performance.now() - start) / 20).toBeLessThan(25);
  });
});
