import type { ArtPath, StyleAsset } from '../../document/style';

/**
 * The backdrops Draft Canvas comes with: quiet papers to draw on.
 *
 * Each is an ordinary drawing (`StyleAsset`), written into the style that uses it like any other,
 * so a diagram never names one of these and is unchanged if one here changes or goes away. All
 * are painted in the text colour, faintly, so the same backdrop reads on a light canvas and a
 * dark one. Every tile joins itself on all four sides.
 */
export interface BuiltinBackdrop {
  id: string;
  label: string;
  description: string;
  asset: StyleAsset;
}

const n = (value: number) => String(Math.round(value * 100) / 100);
const K = 0.5523;
/** A circle as four curves: the stored form has no arcs. */
function dot(cx: number, cy: number, r: number): string {
  const k = r * K;
  return (
    `M${n(cx + r)} ${n(cy)}C${n(cx + r)} ${n(cy + k)} ${n(cx + k)} ${n(cy + r)} ${n(cx)} ${n(cy + r)}` +
    `C${n(cx - k)} ${n(cy + r)} ${n(cx - r)} ${n(cy + k)} ${n(cx - r)} ${n(cy)}` +
    `C${n(cx - r)} ${n(cy - k)} ${n(cx - k)} ${n(cy - r)} ${n(cx)} ${n(cy - r)}` +
    `C${n(cx + k)} ${n(cy - r)} ${n(cx + r)} ${n(cy - k)} ${n(cx + r)} ${n(cy)}Z`
  );
}
const seg = (x1: number, y1: number, x2: number, y2: number) => `M${n(x1)} ${n(y1)}L${n(x2)} ${n(y2)}`;
const line = (d: string, sw: number, o: number): ArtPath => ({ d, stroke: 'text', sw, o });
const fill = (d: string, o: number): ArtPath => ({ d, fill: 'text', o });

/** Drafting paper: fine squares, a heavier line every fifth, a registration cross where they meet. */
function blueprint(): StyleAsset {
  const size = 160;
  const step = 32;
  let minor = '';
  for (let at = step; at < size; at += step) minor += seg(at, 0, at, size) + seg(0, at, size, at);
  // On both edges: a line on an edge shows half of itself in each of the two tiles it divides.
  const major = seg(0, 0, size, 0) + seg(0, 0, 0, size) + seg(0, size, size, size) + seg(size, 0, size, size);
  const cross = seg(-5, 0, 5, 0) + seg(0, -5, 0, 5) + seg(size - 5, 0, size + 5, 0) + seg(size, -5, size, 5) + seg(-5, size, 5, size) + seg(0, size - 5, 0, size + 5) + seg(size - 5, size, size + 5, size) + seg(size, size - 5, size, size + 5);
  return { id: 'abackdropgrid1', w: size, h: size, paths: [line(minor, 1, 0.08), line(major, 1, 0.16), line(cross, 1.4, 0.35)] };
}

/** Laid paper: close diagonal rules. */
function hatch(): StyleAsset {
  const size = 48;
  let d = '';
  for (let at = -size; at <= size; at += 12) d += seg(at, size, at + size, 0);
  return { id: 'abackdrophatch', w: size, h: size, paths: [line(d, 1, 0.1)] };
}

/** A contour map: long, slow curves, a little apart. */
function contours(): StyleAsset {
  const w = 320;
  const h = 200;
  const wave = (y: number, a: number) => `M0 ${n(y)}C${n(w * 0.25)} ${n(y - a)} ${n(w * 0.25)} ${n(y + a)} ${n(w * 0.5)} ${n(y)}C${n(w * 0.75)} ${n(y - a)} ${n(w * 0.75)} ${n(y + a)} ${w} ${n(y)}`;
  return {
    id: 'abackdropwaves',
    w,
    h,
    paths: [line(wave(25, 18) + wave(125, 22), 1.2, 0.13), line(wave(75, 14) + wave(175, 16), 1, 0.08)],
  };
}

/** Honeycomb: a hexagon mesh. */
function honeycomb(): StyleAsset {
  const r = 28;
  const w = Math.round(r * Math.sqrt(3) * 100) / 100;
  const h = r * 3;
  const hex = (cx: number, cy: number) => {
    let d = '';
    for (let i = 0; i < 6; i += 1) {
      const a = (Math.PI / 3) * i - Math.PI / 2;
      d += `${i === 0 ? 'M' : 'L'}${n(cx + r * Math.cos(a))} ${n(cy + r * Math.sin(a))}`;
    }
    return `${d}Z`;
  };
  const d = hex(0, 0) + hex(w, 0) + hex(w / 2, r * 1.5) + hex(0, h) + hex(w, h);
  return { id: 'abackdrophexes', w, h, paths: [line(d, 1, 0.1)] };
}

/** Confetti: small marks, scattered, none on an edge. */
function confetti(): StyleAsset {
  const size = 240;
  const plus = (x: number, y: number, r: number) => seg(x - r, y, x + r, y) + seg(x, y - r, x, y + r);
  const dots = dot(34, 46, 3) + dot(150, 28, 2.2) + dot(206, 122, 3.2) + dot(92, 176, 2.4) + dot(22, 206, 2);
  const rings = dot(112, 96, 6) + dot(196, 208, 5) + dot(58, 118, 4.5);
  const marks = plus(72, 30, 5) + plus(178, 76, 4) + plus(138, 168, 5.5) + plus(28, 150, 4) + plus(214, 40, 3.5);
  const ticks = seg(96, 60, 106, 52) + seg(160, 120, 172, 126) + seg(40, 84, 48, 94) + seg(118, 214, 128, 206) + seg(188, 160, 194, 150);
  return { id: 'abackdropconfetti', w: size, h: size, paths: [fill(dots, 0.21), line(rings, 1.4, 0.16), line(marks, 1.5, 0.19), line(ticks, 1.5, 0.14)] };
}

/** A night sky: stars of three sizes, scattered so no row or column of them shows when it repeats. */
function stars(): StyleAsset {
  const size = 520;
  const star = (x: number, y: number, r: number) => {
    const q = r * 0.26;
    return `M${n(x)} ${n(y - r)}L${n(x + q)} ${n(y - q)}L${n(x + r)} ${n(y)}L${n(x + q)} ${n(y + q)}L${n(x)} ${n(y + r)}L${n(x - q)} ${n(y + q)}L${n(x - r)} ${n(y)}L${n(x - q)} ${n(y - q)}Z`;
  };
  // Placed by hand, off any grid, and none within reach of an edge.
  const big = star(84, 118, 7) + star(402, 62, 6) + star(318, 396, 7.5);
  const small = star(226, 44, 3.6) + star(148, 302, 4) + star(468, 248, 3.4) + star(52, 432, 3.8) + star(266, 214, 3.2) + star(436, 470, 4);
  const dust =
    dot(30, 40, 1.3) + dot(176, 172, 1.1) + dot(332, 128, 1.4) + dot(484, 140, 1) + dot(112, 226, 1.2) + dot(214, 352, 1.4) + dot(378, 286, 1.1) +
    dot(40, 318, 1) + dot(286, 478, 1.3) + dot(152, 462, 1.1) + dot(496, 372, 1.3) + dot(352, 216, 1) + dot(248, 122, 1.2) + dot(92, 20, 1);
  return { id: 'abackdropstars1', w: size, h: size, paths: [fill(big, 0.3), fill(small, 0.2), fill(dust, 0.32)] };
}

export const BUILTIN_BACKDROPS: readonly BuiltinBackdrop[] = [
  { id: 'blueprint', label: 'Drafting', description: 'Squared drafting paper.', asset: blueprint() },
  { id: 'hatch', label: 'Laid', description: 'Fine diagonal rules.', asset: hatch() },
  { id: 'contours', label: 'Contours', description: 'Slow contour lines.', asset: contours() },
  { id: 'honeycomb', label: 'Honeycomb', description: 'A hexagon mesh.', asset: honeycomb() },
  { id: 'confetti', label: 'Confetti', description: 'Small scattered marks.', asset: confetti() },
  { id: 'stars', label: 'Stars', description: 'A few stars.', asset: stars() },
];

const BUILTIN_IDS = new Set(BUILTIN_BACKDROPS.map((entry) => entry.asset.id));

/** Whether `id` is one of the drawings above, by the id each is written into a style under. */
export const isBuiltinBackdrop = (id: string): boolean => BUILTIN_IDS.has(id);
