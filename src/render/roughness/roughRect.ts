import { jitter } from './seed';

/**
 * A jittered rounded-rect outline path, used by `box`/`note`/`group`/
 * `codeCard` when a preset's amplitude is above zero. At `amplitude === 0`
 * this still returns a valid analytic rounded rect, but callers branch
 * before reaching here — they emit a plain `RectShape` for Clean instead, so
 * Clean's serialized SVG element type (`<rect>`) never changes, only Draft/
 * Sketch switch to this jittered `<path>`. "Controlled imperfection, not
 * randomized geometry": the four corners and four edge midpoints each move
 * independently by at most `amplitude`, so the rect's silhouette identity
 * (still roughly `x,y,w,h`) is never in doubt.
 */
export function roughRectPath(
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  seedId: string,
  amplitude: number,
): string {
  if (amplitude === 0) {
    return (
      `M${x + r},${y} H${x + w - r} A${r},${r} 0 0 1 ${x + w},${y + r} ` +
      `V${y + h - r} A${r},${r} 0 0 1 ${x + w - r},${y + h} H${x + r} ` +
      `A${r},${r} 0 0 1 ${x},${y + h - r} V${y + r} A${r},${r} 0 0 1 ${x + r},${y} Z`
    );
  }
  const j = (i: number) => jitter(seedId, i, amplitude);
  const tl = { x: x + j(0), y: y + j(1) };
  const tr = { x: x + w + j(2), y: y + j(3) };
  const br = { x: x + w + j(4), y: y + h + j(5) };
  const bl = { x: x + j(6), y: y + h + j(7) };
  const mid = (a: { x: number; y: number }, b: { x: number; y: number }, i: number) => ({
    x: (a.x + b.x) / 2 + j(i),
    y: (a.y + b.y) / 2 + j(i + 1),
  });
  const top = mid(tl, tr, 8);
  const right = mid(tr, br, 10);
  const bottom = mid(br, bl, 12);
  const left = mid(bl, tl, 14);
  return (
    `M${tl.x},${tl.y} Q${top.x},${top.y} ${tr.x},${tr.y} ` +
    `Q${right.x},${right.y} ${br.x},${br.y} ` +
    `Q${bottom.x},${bottom.y} ${bl.x},${bl.y} ` +
    `Q${left.x},${left.y} ${tl.x},${tl.y} Z`
  );
}

/** A jittered ellipse outline, for `ellipse()` and an actor's head. Returns a
 *  path (not an `EllipseShape`) since an ellipse element has no way to wobble
 *  its rim — four points around the rim (top/right/bottom/left) each nudge
 *  independently, joined by cubic curves approximating the rest of the arc. */
export function roughEllipsePath(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  seedId: string,
  amplitude: number,
): string {
  const k = 0.5523; // circle-to-cubic-bezier constant
  const j = (i: number) => jitter(seedId, i, amplitude);
  const top = { x: cx + j(0), y: cy - ry + j(1) };
  const right = { x: cx + rx + j(2), y: cy + j(3) };
  const bottom = { x: cx + j(4), y: cy + ry + j(5) };
  const left = { x: cx - rx + j(6), y: cy + j(7) };
  const kx = rx * k;
  const ky = ry * k;
  return (
    `M${top.x},${top.y} ` +
    `C${top.x + kx},${top.y} ${right.x},${right.y - ky} ${right.x},${right.y} ` +
    `C${right.x},${right.y + ky} ${bottom.x + kx},${bottom.y} ${bottom.x},${bottom.y} ` +
    `C${bottom.x - kx},${bottom.y} ${left.x},${left.y + ky} ${left.x},${left.y} ` +
    `C${left.x},${left.y - ky} ${top.x - kx},${top.y} ${top.x},${top.y} Z`
  );
}
