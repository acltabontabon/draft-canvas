/**
 * From pointer samples to a stored stroke: thinned, rounded and placed, the compact `DraftInk` the
 * file keeps. Pure — the canvas hands it the samples it collected, in room coordinates.
 */
import { createId } from '../document/ids';
import { INK_ID_PREFIX, inkRound } from '../document/ink';
import { LIMITS } from '../document/limits';
import type { DraftInk, InkColor, InkTool } from '../document/types';
import { distToSegment, type Pt } from './geometry';

export interface InkSample extends Pt {
  /** 0–1, as Pointer Events report it. */
  pressure: number;
}

export interface StrokeStyle {
  tool: InkTool;
  color: InkColor;
  /** Nominal width in room units. */
  size: number;
}

/**
 * Indices to keep under Ramer–Douglas–Peucker at `epsilon`. Index-based so pressure, which runs
 * alongside the points, is thinned with them.
 */
export function simplifyIndices(points: readonly Pt[], epsilon: number): number[] {
  if (points.length <= 2) return points.map((_, i) => i);
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [from, to] = stack.pop()!;
    let worst = -1;
    let index = -1;
    for (let i = from + 1; i < to; i += 1) {
      const d = distToSegment(points[i]!, points[from]!, points[to]!);
      if (d > worst) {
        worst = d;
        index = i;
      }
    }
    if (index !== -1 && worst > epsilon) {
      keep[index] = 1;
      stack.push([from, index], [index, to]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < points.length; i += 1) if (keep[i]) out.push(i);
  return out;
}

/**
 * What `simplifyIndices` keeps at the first of `epsilon`, `epsilon × 1.6`, `× 1.6` again… that keeps
 * at most `limit` points — worked out from one simplification instead of one per epsilon.
 *
 * Ramer–Douglas–Peucker splits a span at its farthest point whatever the epsilon; a larger one only
 * stops splitting sooner. So a point is kept at an epsilon exactly when every split on the way down
 * to it, its own included, is further than that epsilon. The spans are split once, at the first
 * epsilon, each point noting the nearest split on its way down, and the epsilon is then raised
 * until few enough are left. Simplifying the whole stroke again for every epsilon took 2.8 s at
 * pen-up for a stroke of 50,000 samples.
 */
function thinned(points: readonly Pt[], epsilon: number, limit: number): number[] {
  if (points.length <= 2) return points.map((_, i) => i);
  // Kept from the first epsilon on while it is below this; -Infinity for a point that never is.
  const above = new Float64Array(points.length).fill(-Infinity);
  const stack: Array<[number, number, number]> = [[0, points.length - 1, Infinity]];
  while (stack.length > 0) {
    const [from, to, nearest] = stack.pop()!;
    let worst = -1;
    let index = -1;
    for (let i = from + 1; i < to; i += 1) {
      const d = distToSegment(points[i]!, points[from]!, points[to]!);
      if (d > worst) {
        worst = d;
        index = i;
      }
    }
    if (index !== -1 && worst > epsilon) {
      const split = Math.min(nearest, worst);
      above[index] = split;
      stack.push([from, index, split], [index, to, split]);
    }
  }
  const splits = Array.from(above).filter((value) => value > -Infinity).sort((a, b) => b - a);
  // The two ends are always kept; raised the way the loop that simplified again each time raised it.
  let left = splits.length;
  while (left + 2 > limit) {
    epsilon *= 1.6;
    while (left > 0 && splits[left - 1]! <= epsilon) left -= 1;
  }
  const out: number[] = [];
  for (let i = 0; i < points.length; i += 1) if (i === 0 || i === points.length - 1 || above[i]! > epsilon) out.push(i);
  return out;
}

/**
 * The stroke to keep for what was drawn, or `null` for nothing at all. `zoom` sets how finely it is
 * kept: thinned to a third of a screen pixel, so it looks exactly as drawn at the zoom it was drawn
 * at, and costs a fraction of the samples.
 */
export function buildStroke(samples: readonly InkSample[], style: StrokeStyle, options: { zoom: number; pressure: boolean }): DraftInk | null {
  if (samples.length === 0) return null;
  const zoom = options.zoom > 0 ? options.zoom : 1;
  // Repeated samples at (nearly) the same spot say nothing new.
  const distinct: InkSample[] = [samples[0]!];
  const minStep = 0.4 / zoom;
  for (let i = 1; i < samples.length; i += 1) {
    const sample = samples[i]!;
    const last = distinct[distinct.length - 1]!;
    if (Math.hypot(sample.x - last.x, sample.y - last.y) >= minStep) distinct.push(sample);
    else if (sample.pressure > last.pressure) distinct[distinct.length - 1] = { ...last, pressure: sample.pressure };
  }
  const kept = thinned(distinct, 0.33 / zoom, LIMITS.maxInkPoints);
  const origin = { x: inkRound(distinct[0]!.x), y: inkRound(distinct[0]!.y) };
  const points: number[] = [];
  for (const index of kept) {
    const sample = distinct[index]!;
    points.push(inkRound(sample.x - origin.x), inkRound(sample.y - origin.y));
  }
  const stroke: DraftInk = {
    id: createId(INK_ID_PREFIX),
    tool: style.tool,
    color: style.color,
    size: Math.round(Math.min(LIMITS.maxInkSize, Math.max(LIMITS.minInkSize, style.size)) * 100) / 100,
    x: origin.x,
    y: origin.y,
    points,
  };
  if (options.pressure && style.tool === 'pen') {
    const pressure = kept.map((index) => Math.round(Math.min(1, Math.max(0, distinct[index]!.pressure)) * 100));
    // A device that reports one flat value is not reporting pressure.
    if (pressure.some((value) => value !== pressure[0])) stroke.pressure = pressure;
  }
  return stroke;
}
