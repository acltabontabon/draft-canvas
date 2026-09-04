import { jitter } from './seed';

/**
 * The perpendicular-offset control point for bowing an otherwise-straight run from `a` to a
 * fixed `b` — `b` itself never moves, only this new point does. The shared primitive behind
 * every "make a straight run read as hand-drawn without moving its endpoints" use in this
 * codebase: `roughPath.ts`'s `roughenPath` (for routed connector segments) and the hand-rolled
 * cylinder/tube walls in `nodes/describe.ts`'s `database()`/`queue()`.
 */
export function bowControlPoint(
  a: { x: number; y: number },
  b: { x: number; y: number },
  seedId: string,
  index: number,
  bow: number,
): { x: number; y: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const offset = jitter(seedId, index, bow);
  return { x: (a.x + b.x) / 2 + nx * offset, y: (a.y + b.y) / 2 + ny * offset };
}

/**
 * A jittered rounded-rect outline path, used by `box`/`note`/`group`/`codeCard`/`service`/`actor`
 * when a preset's amplitude is above zero. At `cornerAmplitude === 0 && bowAmplitude === 0` this
 * still returns a valid analytic rounded rect, but callers branch before reaching here — they
 * emit a plain `RectShape` for Clean instead, so Clean's serialized SVG element type (`<rect>`)
 * never changes, only Draft/Sketch switch to this jittered `<path>`.
 *
 * Two independent axes: `cornerAmplitude` nudges the four corners (and, through them, where each
 * side starts and ends); `bowAmplitude` additionally bows each side's own midpoint outward or
 * inward, on top of wherever its (possibly jittered) corners landed — so a preset can keep tight
 * corners while still reading as hand-drawn through curved sides (Draft), or push both (Sketch).
 * "Controlled imperfection, not randomized geometry": every point moves independently by at most
 * its own amplitude, so the rect's silhouette identity (still roughly `x,y,w,h`) is never in doubt.
 */
export function roughRectPath(
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  seedId: string,
  cornerAmplitude: number,
  bowAmplitude = 0,
): string {
  if (cornerAmplitude === 0 && bowAmplitude === 0) {
    return (
      `M${x + r},${y} H${x + w - r} A${r},${r} 0 0 1 ${x + w},${y + r} ` +
      `V${y + h - r} A${r},${r} 0 0 1 ${x + w - r},${y + h} H${x + r} ` +
      `A${r},${r} 0 0 1 ${x},${y + h - r} V${y + r} A${r},${r} 0 0 1 ${x + r},${y} Z`
    );
  }
  const j = (i: number) => jitter(seedId, i, cornerAmplitude);
  // A separate re-seed at the same indices, scaled by `bowAmplitude` instead — safe to share the
  // index range with `j` since `jitter` re-seeds fully per `(seedId, index)`, never sharing state
  // across calls, so the two axes can never accidentally correlate or collide.
  const jb = (i: number) => jitter(seedId, i, bowAmplitude);
  const tl = { x: x + j(0), y: y + j(1) };
  const tr = { x: x + w + j(2), y: y + j(3) };
  const br = { x: x + w + j(4), y: y + h + j(5) };
  const bl = { x: x + j(6), y: y + h + j(7) };
  const mid = (a: { x: number; y: number }, b: { x: number; y: number }, i: number) => ({
    x: (a.x + b.x) / 2 + jb(i),
    y: (a.y + b.y) / 2 + jb(i + 1),
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

/**
 * Four independent, disconnected side-strokes — a corner-overshoot pass meant to be painted on
 * top of a filled `roughRectPath` outline, never in place of it. Each side reuses the *exact*
 * jittered corner points `roughRectPath` computes for the same `(seedId, cornerAmplitude)` (same
 * indices 0-7), so it traces the same rect, not a differently-wobbled one — only whether a side's
 * own stroke reaches precisely to its corner, overshoots past it, or stops short is new here,
 * using a disjoint index band (30+) so it can never collide with the corner jitter it depends on.
 * The classic "the pen crossed past where it should have stopped" hand-drawn tell. Returns `''`
 * (nothing to paint) when `overshootAmplitude` is 0 — the technique is fully off, not just small.
 *
 * No corner radius parameter: like `roughRectPath`'s own jittered branch (which this pass is
 * always layered on top of), it works from the rect's four sharp bounding-box corners — rounding
 * is a Clean-only concept once amplitude is above zero.
 */
export function roughRectOvershootPath(
  x: number,
  y: number,
  w: number,
  h: number,
  seedId: string,
  cornerAmplitude: number,
  overshootAmplitude: number,
): string {
  if (overshootAmplitude === 0) return '';
  const j = (i: number) => jitter(seedId, i, cornerAmplitude);
  const os = (i: number) => jitter(seedId, 30 + i, overshootAmplitude);
  const tl = { x: x + j(0), y: y + j(1) };
  const tr = { x: x + w + j(2), y: y + j(3) };
  const br = { x: x + w + j(4), y: y + h + j(5) };
  const bl = { x: x + j(6), y: y + h + j(7) };
  const side = (a: { x: number; y: number }, b: { x: number; y: number }, i: number) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const start = { x: a.x - ux * os(i), y: a.y - uy * os(i) };
    const end = { x: b.x + ux * os(i + 1), y: b.y + uy * os(i + 1) };
    return `M${start.x},${start.y} L${end.x},${end.y}`;
  };
  return [side(tl, tr, 0), side(tr, br, 2), side(br, bl, 4), side(bl, tl, 6)].join(' ');
}

/**
 * A jittered ellipse outline, for `ellipse()`/Junction and an actor's head. Returns a path (not
 * an `EllipseShape`) since an ellipse element has no way to wobble its rim — four points around
 * the rim (top/right/bottom/left) each nudge independently, joined by cubic curves approximating
 * the rest of the arc.
 *
 * `bowAmplitude` independently perturbs each quarter-arc's own control-point handle length (how
 * far it bulges from the straight chord between its two rim points), on top of the rim points'
 * own position — the ellipse analogue of `roughRectPath`'s side-midpoint bow, so a preset can
 * bow the curve of each quarter without moving where the rim points themselves land.
 */
export function roughEllipsePath(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  seedId: string,
  rimAmplitude: number,
  bowAmplitude = 0,
): string {
  const k = 0.5523; // circle-to-cubic-bezier constant
  const j = (i: number) => jitter(seedId, i, rimAmplitude);
  // A disjoint band (10+) from the rim points' 0-7, so re-seeding a handle can never collide
  // with a rim point's own jitter.
  const jb = (i: number) => jitter(seedId, 10 + i, bowAmplitude);
  const top = { x: cx + j(0), y: cy - ry + j(1) };
  const right = { x: cx + rx + j(2), y: cy + j(3) };
  const bottom = { x: cx + j(4), y: cy + ry + j(5) };
  const left = { x: cx - rx + j(6), y: cy + j(7) };
  // One independent (x, y) handle-length pair per quarter-arc — collapses to the plain
  // `(rx * k, ry * k)` circle-to-bezier constant at `bowAmplitude === 0`, so this is a pure
  // extension of the existing curve, not a different one.
  const q1 = { x: rx * k + jb(0), y: ry * k + jb(1) }; // top → right
  const q2 = { x: rx * k + jb(2), y: ry * k + jb(3) }; // right → bottom
  const q3 = { x: rx * k + jb(4), y: ry * k + jb(5) }; // bottom → left
  const q4 = { x: rx * k + jb(6), y: ry * k + jb(7) }; // left → top
  return (
    `M${top.x},${top.y} ` +
    `C${top.x + q1.x},${top.y} ${right.x},${right.y - q1.y} ${right.x},${right.y} ` +
    `C${right.x},${right.y + q2.y} ${bottom.x + q2.x},${bottom.y} ${bottom.x},${bottom.y} ` +
    `C${bottom.x - q3.x},${bottom.y} ${left.x},${left.y + q3.y} ${left.x},${left.y} ` +
    `C${left.x},${left.y - q4.y} ${top.x - q4.x},${top.y} ${top.x},${top.y} Z`
  );
}
