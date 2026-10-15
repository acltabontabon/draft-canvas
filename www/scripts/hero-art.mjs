#!/usr/bin/env node
/*
 * Draws the landing page's hero: a pencil sketch of an orders system, and the ink drawing over it.
 *
 *     npm --prefix www run art
 *
 * Rewrites the markup between `<!-- art:wide -->` and `<!-- /art:wide -->` (and `art:narrow`) in
 * www/index.html. The pencil strokes are jittered, overshooting and a little bowed, which is a job
 * for a seeded generator rather than a hand: the seeds below reproduce the same strokes on every run,
 * so a re-run after a geometry change only moves what changed. The output is committed — the build
 * never runs this.
 *
 * The ink follows src/nodes/describe.ts. An API is a card with a socket notch in its left edge, a
 * Worker two stacked cards with two dots rather than three, a queue a tube with three envelopes and
 * its name below, and a shape with an inside view carries the faint plane behind it. Every caption
 * is one the capability matrix would produce for those two ends.
 *
 * Every stroke carries `pathLength="1"` and a `--d` delay, which is all styles.css needs to draw it
 * in; the resting state is the finished drawing, so it reads with no motion at all.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const page = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html');
const r1 = (n) => Math.round(n * 10) / 10;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeSketch(seed) {
  const rand = rng(seed);
  const between = (a, b) => a + (b - a) * rand();
  const jit = (s) => (rand() * 2 - 1) * s;

  // One pencil stroke from A to B: overshoots both ends, bows a little, never quite on the line.
  function line(x1, y1, x2, y2, { over = 7, bow = 1.6, wob = 1.2 } = {}) {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len, px = -uy, py = ux;
    const s = between(1.5, over), e = between(1.5, over);
    const ax = x1 - ux * s + px * jit(wob), ay = y1 - uy * s + py * jit(wob);
    const bx = x2 + ux * e + px * jit(wob), by = y2 + uy * e + py * jit(wob);
    const b = jit(bow) + (len > 120 ? jit(bow) : 0);
    const cx = (ax + bx) / 2 + px * b, cy = (ay + by) / 2 + py * b;
    return `M${r1(ax)} ${r1(ay)}Q${r1(cx)} ${r1(cy)} ${r1(bx)} ${r1(by)}`;
  }

  // A smooth stroke through points (Catmull-Rom as cubic Béziers).
  function smooth(pts) {
    let d = `M${r1(pts[0][0])} ${r1(pts[0][1])}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] ?? pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] ?? p2;
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
      const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
      d += `C${r1(c1[0])} ${r1(c1[1])} ${r1(c2[0])} ${r1(c2[1])} ${r1(p2[0])} ${r1(p2[1])}`;
    }
    return d;
  }

  // An ellipse drawn in one go and carried a little past where it started, as a hand does.
  function ellipse(cx, cy, rx, ry, { from = between(0, Math.PI * 2), turn = between(1.04, 1.14), steps = 22, wob = 1.1 } = {}) {
    const pts = [];
    const tilt = jit(0.03);
    for (let i = 0; i <= steps; i++) {
      const t = from + (i / steps) * Math.PI * 2 * turn;
      const k = 1 + jit(0.02) + (i / steps) * 0.03;
      const x = Math.cos(t) * rx * k, y = Math.sin(t) * ry * k;
      pts.push([cx + x * Math.cos(tilt) - y * Math.sin(tilt) + jit(wob * 0.4), cy + x * Math.sin(tilt) + y * Math.cos(tilt) + jit(wob * 0.4)]);
    }
    return smooth(pts);
  }

  // Half an ellipse (the near rim of a cylinder, a tube's end).
  function arc(cx, cy, rx, ry, a0, a1, { steps = 12, wob = 0.9 } = {}) {
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const t = a0 + (i / steps) * (a1 - a0);
      pts.push([cx + Math.cos(t) * rx + jit(wob * 0.4), cy + Math.sin(t) * ry + jit(wob * 0.4)]);
    }
    return smooth(pts);
  }

  // Handwriting where a name will go: loops of a fast cursive, with a gap between words.
  function scribble(x, y, w, { h = 6 } = {}) {
    const pts = [];
    let cx = x;
    let up = true;
    const gapAt = w > 60 ? x + w * between(0.4, 0.6) : Infinity;
    let gapped = false;
    const strokes = [];
    while (cx < x + w) {
      if (!gapped && cx > gapAt) {
        strokes.push(smooth(pts.splice(0)));
        cx += between(6, 9);
        gapped = true;
        continue;
      }
      pts.push([cx, y + (up ? -h * between(0.55, 1.05) : between(0, 1.2))]);
      cx += between(2.6, 4.4);
      up = !up;
    }
    if (pts.length > 1) strokes.push(smooth(pts));
    return strokes;
  }

  function box(x, y, w, h) {
    const strokes = [
      line(x, y, x + w, y),
      line(x + w, y, x + w, y + h, { over: 6 }),
      line(x + w, y + h, x, y + h),
      line(x, y + h, x, y, { over: 6 }),
    ];
    // A second, lighter pass on two sides — the correction a quick sketch always gets.
    if (rand() > 0.35) strokes.push(line(x + w * 0.08, y + jit(2), x + w * between(0.55, 0.95), y + jit(2), { over: 3 }));
    if (rand() > 0.5) strokes.push(line(x + jit(2), y + h * 0.15, x + jit(2), y + h * between(0.6, 0.95), { over: 3 }));
    return strokes;
  }

  function arrow(x1, y1, x2, y2) {
    const a = Math.atan2(y2 - y1, x2 - x1);
    const tipX = x2 + jit(1.5), tipY = y2 + jit(1.5);
    const k = 9;
    const spread = 0.48 + jit(0.06);
    return [
      line(x1, y1, x2, y2, { over: 4, bow: 2.4, wob: 2.2 }),
      `M${r1(tipX - Math.cos(a - spread) * k)} ${r1(tipY - Math.sin(a - spread) * k)}L${r1(tipX)} ${r1(tipY)}L${r1(tipX - Math.cos(a + spread) * k)} ${r1(tipY - Math.sin(a + spread) * k)}`,
    ];
  }

  return { line, ellipse, arc, scribble, box, arrow, between, jit, smooth };
}

/* ── Ink silhouettes, after src/nodes/describe.ts ─────────────────────────────────────────── */

const DOTS = (rightX, cy, count) =>
  Array.from({ length: count }, (_, i) => `<circle cx="${r1(rightX - i * 5)}" cy="${r1(cy)}" r="1.7"/>`).join('');

function rounded(x, y, w, h, r = 8) {
  return `M${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + h - r}Q${x + w} ${y + h} ${x + w - r} ${y + h}H${x + r}Q${x} ${y + h} ${x} ${y + h - r}V${y + r}Q${x} ${y} ${x + r} ${y}Z`;
}

function apiOutline(x, y, w, h, r = 8) {
  const notchH = h * 0.34, depth = 8, nr = 3;
  const top = y + (h - notchH) / 2, bottom = top + notchH;
  return `M${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + h - r}Q${x + w} ${y + h} ${x + w - r} ${y + h}H${x + r}Q${x} ${y + h} ${x} ${y + h - r}V${r1(bottom)}H${x + depth - nr}Q${x + depth} ${r1(bottom)} ${x + depth} ${r1(bottom - nr)}V${r1(top + nr)}Q${x + depth} ${r1(top)} ${x + depth - nr} ${r1(top)}H${x}V${y + r}Q${x} ${y} ${x + r} ${y}Z`;
}

function cap(x, y, w, r = 8) {
  // The 4-unit band across a service card's top, clipped to its corners.
  return `M${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + 4}H${x}V${y + r}Q${x} ${y} ${x + r} ${y}Z`;
}

function envelopes(cx, cy, count = 3) {
  const w = 17, h = 13, gap = 6;
  const start = cx - (w * count + gap * (count - 1)) / 2;
  return Array.from({ length: count }, (_, i) => {
    const ex = r1(start + i * (w + gap)), ey = r1(cy - h / 2);
    return `<path d="M${ex} ${ey}h${w}v${h}h${-w}zM${ex} ${ey}L${r1(ex + w / 2)} ${r1(ey + h * 0.6)}L${r1(ex + w)} ${ey}"/>`;
  }).join('');
}

function tube(x, y, w, h) {
  // A queue: a horizontal cylinder, its lid the ellipse at the far end.
  const rx = Math.min(14, h / 2), ry = h / 2;
  const body = `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`;
  const lid = `M${x + w - rx} ${y}A${rx} ${ry} 0 0 0 ${x + w - rx} ${y + h}`;
  return { body, lid, rx, ry };
}

function cylinder(cx, top, rx, ry, height) {
  const l = cx - rx, r = cx + rx;
  const body = `M${l} ${top}A${rx} ${ry} 0 0 1 ${r} ${top}V${top + height}A${rx} ${ry} 0 0 1 ${l} ${top + height}Z`;
  const rim = `M${l} ${top}A${rx} ${ry} 0 0 0 ${r} ${top}`;
  return { body, rim };
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/* ── A drawing ─────────────────────────────────────────────────────────────────────────────── */

function build(spec, seed) {
  const sk = makeSketch(seed);
  const pencil = [];
  const scribbles = [];
  const guides = [];
  const ink = { boundary: '', wires: [], nodes: [], notes: [], steps: [], pulses: [] };
  let t = 0; // pencil time cursor, seconds
  const P = (d, delay, cls = '') => pencil.push(`<path${cls ? ` class="${cls}"` : ''} d="${d}" pathLength="1" style="--d:${r1(delay * 100) / 100}"/>`);

  // Construction lines: the rows and columns the drawing hangs off, put down before anything else.
  for (const [i, g] of spec.guides.entries()) {
    const d = g.y !== undefined ? `M${g.from} ${g.y}H${g.to}` : `M${g.x} ${g.from}V${g.to}`;
    guides.push(`<path d="${d}" pathLength="1" style="--d:${r1(0.1 + i * 0.08)}"/>`);
  }

  // Pencil pass, node by node, then the arrows.
  for (const n of spec.nodes) {
    const start = 0.35 + t;
    let strokes = [];
    if (n.type === 'service' || n.type === 'api') strokes = sk.box(n.x, n.y, n.w, n.h);
    if (n.type === 'worker') strokes = [...sk.box(n.x, n.y, n.w - 6, n.h - 6), sk.line(n.x + n.w - 6, n.y + 8, n.x + n.w, n.y + 8 + 4, { over: 2 }), sk.line(n.x + n.w, n.y + 12, n.x + n.w, n.y + n.h, { over: 4 }), sk.line(n.x + n.w, n.y + n.h, n.x + 10, n.y + n.h, { over: 4 })];
    if (n.type === 'tube') {
      const rx = 14, ry = n.h / 2;
      strokes = [
        sk.line(n.x + rx, n.y, n.x + n.w - rx, n.y, { over: 8 }),
        sk.line(n.x + n.w - rx, n.y + n.h, n.x + rx, n.y + n.h, { over: 8 }),
        sk.arc(n.x + rx, n.y + ry, rx, ry, Math.PI * 0.5, Math.PI * 1.55),
        sk.ellipse(n.x + n.w - rx, n.y + ry, rx, ry, { steps: 14 }),
      ];
    }
    if (n.type === 'store') {
      strokes = [
        sk.ellipse(n.cx, n.top, n.rx, n.ry),
        sk.line(n.cx - n.rx, n.top, n.cx - n.rx, n.top + n.height, { over: 3 }),
        sk.line(n.cx + n.rx, n.top, n.cx + n.rx, n.top + n.height, { over: 3 }),
        sk.arc(n.cx, n.top + n.height, n.rx, n.ry, 0, Math.PI),
      ];
    }
    if (n.type === 'note') strokes = sk.box(n.x, n.y, n.w, n.h);
    strokes.forEach((d, i) => P(d, start + i * 0.07));

    // Handwriting where the name will be typeset.
    const sx = n.scribble;
    if (sx) for (const [j, w] of sx.lines.entries()) for (const d of sk.scribble(sx.x - w / 2, sx.y + j * 13, w)) scribbles.push(`<path d="${d}" pathLength="1" style="--d:${r1((start + 0.25 + j * 0.08) * 100) / 100}"/>`);
    t += 0.16;
  }
  for (const w of spec.wires) {
    const start = 0.35 + t;
    const [a, b] = [w.pts[0], w.pts[w.pts.length - 1]];
    sk.arrow(a[0] + (w.pencilOffset?.[0] ?? 0), a[1] + (w.pencilOffset?.[1] ?? 0), b[0] + (w.pencilOffset?.[0] ?? 0), b[1] + (w.pencilOffset?.[1] ?? 0)).forEach((d, i) => P(d, start + i * 0.12));
    t += 0.1;
  }
  // The enclosure: one loose loop around what belongs together.
  if (spec.boundary) {
    const b = spec.boundary;
    P(sk.ellipse((b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2, (b.x2 - b.x1) / 2 + 26, (b.y2 - b.y1) / 2 + 22, { steps: 30, wob: 2.4, from: Math.PI * 1.15, turn: 1.06 }), 0.35 + t);
  }
  const pencilEnd = 0.35 + t + 0.5;

  // Ink.
  const inkStart = Math.max(1.5, pencilEnd - 0.3);
  if (spec.boundary) {
    const b = spec.boundary, k = 16;
    const d = `M${b.x1} ${b.y1 + k}V${b.y1}H${b.x1 + k}M${b.x2 - k} ${b.y1}H${b.x2}V${b.y1 + k}M${b.x2} ${b.y2 - k}V${b.y2}H${b.x2 - k}M${b.x1 + k} ${b.y2}H${b.x1}V${b.y2 - k}`;
    ink.boundary = `<g class="bnd" style="--d:${r1(inkStart + 1.2)}"><path d="${d}"/><text class="t-bnd" x="${b.x1}" y="${b.y1 - 10}">${b.label}<tspan class="t-bnd-kind" dx="8">${b.kind}</tspan></text></g>`;
  }

  spec.nodes.forEach((n, i) => {
    const d = r1(inkStart + i * 0.14);
    let body = '';
    if (n.type === 'service' || n.type === 'api') {
      const outline = n.type === 'api' ? apiOutline(n.x, n.y, n.w, n.h) : rounded(n.x, n.y, n.w, n.h);
      const plane = n.inside ? `<path class="plane" d="${rounded(n.x + 6, n.y + 6, n.w, n.h)}"/>` : '';
      body = `${plane}<path class="n-fill" d="${outline}"/><path class="n-cap" d="${cap(n.x, n.y, n.w)}"/><path class="n-line" d="${outline}" pathLength="1"/>`;
      if (n.type === 'service') body += `<g class="dots">${DOTS(n.x + n.w - 12, n.y + 13, 3)}</g>`;
      if (n.kind) body += `<text class="t-kind" x="${n.x + n.w - 7}" y="${n.y + n.h - 7}" text-anchor="end">${n.kind}</text>`;
    }
    if (n.type === 'worker') {
      const fw = n.w - 6, fh = n.h - 6;
      body = `<path class="n-fill" d="${rounded(n.x + 6, n.y + 6, fw, fh)}"/><path class="n-line n-back" d="${rounded(n.x + 6, n.y + 6, fw, fh)}" pathLength="1"/>` +
        `<path class="n-fill" d="${rounded(n.x, n.y, fw, fh)}"/><path class="n-cap" d="${cap(n.x, n.y, fw)}"/><path class="n-line" d="${rounded(n.x, n.y, fw, fh)}" pathLength="1"/>` +
        `<g class="dots">${DOTS(n.x + fw - 12, n.y + 13, 2)}</g>` +
        `<text class="t-kind" x="${n.x + fw - 8}" y="${n.y + fh - 7}" text-anchor="end">WORKER</text>`;
    }
    if (n.type === 'tube') {
      const tb = tube(n.x, n.y, n.w, n.h);
      body = `<path class="n-fill" d="${tb.body}"/><path class="n-line" d="${tb.body}" pathLength="1"/><path class="n-line" d="${tb.lid}" pathLength="1"/><g class="glyph">${envelopes(n.x + (n.w - tb.rx) / 2, n.y + n.h / 2)}</g>`;
    }
    if (n.type === 'store') {
      const c = cylinder(n.cx, n.top, n.rx, n.ry, n.height);
      body = `<path class="n-fill" d="${c.body}"/><path class="n-line" d="${c.body}" pathLength="1"/><path class="n-line" d="${c.rim}" pathLength="1"/>`;
    }
    if (n.type === 'note') {
      body = `<path class="n-fill note-fill" d="${rounded(n.x, n.y, n.w, n.h, 6)}"/><path class="n-line note-line" d="${rounded(n.x, n.y, n.w, n.h, 6)}" pathLength="1"/>` +
        `<text class="t-tag" x="${n.x + 12}" y="${n.y + 20}">${n.tag}</text>` +
        n.lines.map((l, j) => `<text class="t-note" x="${n.x + 12}" y="${n.y + 40 + j * 16}">${esc(l)}</text>`).join('');
      if (n.leader) body += `<path class="leader" d="${n.leader}"/>`;
    }
    const label = n.name
      ? `<text class="t-name" x="${n.label.x}" y="${n.label.y}" text-anchor="middle">${esc(n.name)}</text>` +
        (n.tech ? `<text class="t-tech" x="${n.label.x}" y="${n.label.y + 17}" text-anchor="middle">${esc(n.tech)}</text>` : '') +
        (n.below ? `<text class="t-kind" x="${n.label.x}" y="${n.label.y + 16}" text-anchor="middle">${n.below}</text>` : '')
      : '';
    (n.type === 'note' ? ink.notes : ink.nodes).push(`<g class="node n-${n.type}" style="--d:${d}">${body}${label}</g>`);
  });

  const wireStart = inkStart + spec.nodes.length * 0.14 + 0.1;
  spec.wires.forEach((w, i) => {
    const d = r1(wireStart + i * 0.18);
    const path = `M${w.pts.map((p) => p.join(' ')).join('L')}`;
    const [p1, p2] = w.pts.slice(-2);
    const a = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]);
    const tip = p2, k = 8, s = 4.5;
    const head = `M${r1(tip[0] - Math.cos(a) * k - Math.sin(a) * s)} ${r1(tip[1] - Math.sin(a) * k + Math.cos(a) * s)}L${tip[0]} ${tip[1]}L${r1(tip[0] - Math.cos(a) * k + Math.sin(a) * s)} ${r1(tip[1] - Math.sin(a) * k - Math.cos(a) * s)}Z`;
    const cap = w.caption;
    ink.wires.push(
      `<g class="wire ${p1[1] === p2[1] ? 'w-h' : 'w-v'}${w.async ? ' async' : ''}" style="--d:${d}"><path class="w-line" d="${path}" pathLength="1"/><path class="w-head" d="${head}"/>` +
        `<text class="t-edge" x="${cap.x}" y="${cap.y}" text-anchor="${cap.anchor ?? 'middle'}">${cap.text}</text></g>`,
    );
    if (w.step) {
      const [bx, by] = w.step.at;
      ink.steps.push(`<g class="step" style="--s:${w.step.n}"><circle cx="${bx}" cy="${by}" r="8"/><text x="${bx}" y="${by + 3.6}" text-anchor="middle">${w.step.n}</text></g>`);
      ink.pulses.push(`<path class="pulse" d="${path}" pathLength="1" style="--s:${w.step.n}"/>`);
    }
  });

  const tb = spec.titleblock;
  const titleblock = tb
    ? `<g class="tb"><path d="M${tb.x} ${tb.y}h${tb.w}v${tb.h}h${-tb.w}zM${tb.x} ${tb.y + tb.h / 2}h${tb.w}M${tb.x + tb.split} ${tb.y + tb.h / 2}v${tb.h / 2}"/>` +
      `<text x="${tb.x + 10}" y="${tb.y + tb.h / 2 - 8}">${tb.title}</text>` +
      `<text x="${tb.x + 10}" y="${tb.y + tb.h - 8}">${tb.left}</text><text x="${tb.x + tb.split + 10}" y="${tb.y + tb.h - 8}">${tb.right}</text></g>`
    : '';

  const reg = (spec.reg ?? []).map(([x, y]) => `<path d="M${x - 6} ${y}h12M${x} ${y - 6}v12"/>`).join('');

  return `<svg class="art art-${spec.name}" viewBox="0 0 ${spec.w} ${spec.h}" aria-hidden="true" focusable="false">
  <defs>
    <filter id="graphite-${spec.name}" x="-2%" y="-2%" width="104%" height="104%">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="${seed % 97}" result="grain"/>
      <feDisplacementMap in="SourceGraphic" in2="grain" scale="1.6" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
  </defs>
  <g class="reg">${reg}</g>
  <g class="guides">${guides.join('')}</g>
  <g class="pencil" filter="url(#graphite-${spec.name})">${pencil.join('')}<g class="scribble">${scribbles.join('')}</g></g>
  <g class="ink">
    ${ink.boundary}
    ${ink.wires.join('\n    ')}
    ${ink.nodes.join('\n    ')}
    ${ink.notes.join('\n    ')}
  </g>
  <g class="flow">${ink.pulses.join('')}${ink.steps.join('')}</g>
  ${titleblock}
</svg>`;
}

/* ── The two compositions ─────────────────────────────────────────────────────────────────── */

const wide = {
  name: 'wide', w: 760, h: 520,
  reg: [[10, 10], [750, 10], [10, 510], [750, 510]],
  guides: [
    { y: 114, from: 0, to: 760 }, { y: 341, from: 0, to: 760 },
    { x: 104, from: 30, to: 470 }, { x: 380, from: 30, to: 470 }, { x: 600, from: 30, to: 470 },
  ],
  boundary: { x1: 268, y1: 56, x2: 744, y2: 428, label: 'ORDERS', kind: 'SYSTEM' },
  nodes: [
    { id: 'storefront', type: 'service', x: 24, y: 78, w: 160, h: 72, name: 'Storefront', tech: '[Next.js]', label: { x: 104, y: 116 }, scribble: { x: 104, y: 114, lines: [64] } },
    { id: 'api', type: 'api', inside: true, x: 292, y: 78, w: 176, h: 72, name: 'Orders API', tech: '[TypeScript]', kind: 'API', label: { x: 384, y: 116 }, scribble: { x: 384, y: 114, lines: [72] } },
    { id: 'queue', type: 'tube', x: 560, y: 98, w: 150, h: 32, name: 'orders', below: 'QUEUE', label: { x: 635, y: 152 }, scribble: { x: 635, y: 152, lines: [40] } },
    { id: 'db', type: 'store', cx: 380, top: 318, rx: 48, ry: 13, height: 46, name: 'Orders DB', label: { x: 380, y: 404 }, scribble: { x: 380, y: 404, lines: [56] } },
    { id: 'worker', type: 'worker', x: 552, y: 300, w: 166, h: 78, name: 'Fulfilment', tech: '[Go]', label: { x: 632, y: 334 }, scribble: { x: 632, y: 332, lines: [62] } },
    { id: 'note', type: 'note', x: 36, y: 300, w: 200, h: 84, tag: 'DECISION', lines: ['Charge before saving: no', 'unpaid order reaches the', 'database.'], leader: 'M236 341H330', scribble: { x: 120, y: 338, lines: [150, 140, 60] } },
  ],
  wires: [
    { pts: [[184, 114], [292, 114]], caption: { text: 'calls', x: 238, y: 104 }, step: { n: 1, at: [204, 114] }, pencilOffset: [0, 2] },
    { pts: [[380, 150], [380, 305]], caption: { text: 'writes to', x: 392, y: 240, anchor: 'start' }, step: { n: 2, at: [380, 172] }, pencilOffset: [-2, 0] },
    { pts: [[468, 114], [560, 114]], async: true, caption: { text: 'publishes to', x: 514, y: 104 }, step: { n: 3, at: [500, 114] }, pencilOffset: [0, -2] },
    { pts: [[600, 130], [600, 300]], async: true, caption: { text: 'consumed by', x: 588, y: 240, anchor: 'end' }, step: { n: 4, at: [600, 196] }, pencilOffset: [2, 0] },
  ],
  titleblock: { x: 520, y: 452, w: 224, h: 48, split: 112, title: 'CHECKOUT · PLACE AN ORDER', left: 'FLOW · 4 STEPS', right: 'SHEET 1 OF 1' },
};

const narrow = {
  name: 'narrow', w: 340, h: 500,
  reg: [[8, 8], [332, 8], [8, 492], [332, 492]],
  guides: [
    { x: 170, from: 16, to: 430 }, { x: 132, from: 16, to: 430 }, { y: 76, from: 0, to: 340 }, { y: 366, from: 0, to: 340 },
  ],
  boundary: { x1: 52, y1: 30, x2: 288, y2: 418, label: 'ORDERS', kind: 'SYSTEM' },
  nodes: [
    { id: 'api', type: 'api', inside: true, x: 82, y: 42, w: 176, h: 72, name: 'Orders API', tech: '[TypeScript]', kind: 'API', label: { x: 174, y: 80 }, scribble: { x: 174, y: 78, lines: [72] } },
    { id: 'queue', type: 'tube', x: 95, y: 194, w: 150, h: 32, name: 'orders', below: 'QUEUE', label: { x: 170, y: 248 }, scribble: { x: 170, y: 248, lines: [40] } },
    { id: 'worker', type: 'worker', x: 88, y: 326, w: 166, h: 78, name: 'Fulfilment', tech: '[Go]', label: { x: 168, y: 360 }, scribble: { x: 168, y: 358, lines: [62] } },
  ],
  wires: [
    { pts: [[170, 114], [170, 194]], async: true, caption: { text: 'publishes to', x: 182, y: 160, anchor: 'start' }, step: { n: 1, at: [170, 136] }, pencilOffset: [2, 0] },
    { pts: [[132, 226], [132, 326]], async: true, caption: { text: 'consumed by', x: 120, y: 290, anchor: 'end' }, step: { n: 2, at: [132, 252] }, pencilOffset: [-2, 0] },
  ],
  titleblock: { x: 52, y: 440, w: 236, h: 48, split: 118, title: 'CHECKOUT · PLACE AN ORDER', left: 'FLOW · 2 STEPS', right: 'SHEET 1 OF 1' },
};

/** Replaces what sits between a pair of markers, indented to match the opening one. */
function splice(html, name, svg) {
  const pattern = new RegExp(`([ \\t]*)<!-- art:${name} -->[\\s\\S]*?<!-- /art:${name} -->`);
  if (!pattern.test(html)) throw new Error(`hero-art: no <!-- art:${name} --> markers in index.html`);
  return html.replace(pattern, (_, indent) =>
    [`${indent}<!-- art:${name} -->`, ...svg.split('\n').map((line) => indent + line), `${indent}<!-- /art:${name} -->`].join('\n'),
  );
}

let html = readFileSync(page, 'utf8');
html = splice(html, 'wide', build(wide, 1407));
html = splice(html, 'narrow', build(narrow, 2214));
writeFileSync(page, html);
console.log('hero-art: index.html updated');
