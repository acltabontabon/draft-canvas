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
  let epsilon = 0.33 / zoom;
  let kept = simplifyIndices(distinct, epsilon);
  while (kept.length > LIMITS.maxInkPoints) {
    epsilon *= 1.6;
    kept = simplifyIndices(distinct, epsilon);
  }
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
