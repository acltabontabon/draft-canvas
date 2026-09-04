import { bowControlPoint } from './roughRect';
import { jitter } from './seed';

interface PathSegment {
  cmd: string;
  nums: number[];
}

const NUMBER_RE = /-?\d*\.?\d+(?:[eE][-+]?\d+)?/g;

function parseSegments(d: string): PathSegment[] {
  const segments: PathSegment[] = [];
  const commandRe = /([MLQC])([^MLQC]*)/g;
  let match: RegExpExecArray | null;
  while ((match = commandRe.exec(d))) {
    const nums = (match[2].match(NUMBER_RE) ?? []).map(Number);
    segments.push({ cmd: match[1]!, nums });
  }
  return segments;
}

function segmentEndpoint(segment: PathSegment): { x: number; y: number } {
  const n = segment.nums;
  return { x: n[n.length - 2]!, y: n[n.length - 1]! };
}

/**
 * Perturbs an already-routed path's intermediate points (endpoints and control points alike),
 * leaving the very first and very last point exactly where `route.d` put them — a connector's
 * actual attachment coordinates never move, only the line drawn between them wobbles. Only
 * handles the `M`/`L`/`Q`/`C`, all-absolute-uppercase command set `edges/routing.ts` actually
 * produces (React Flow's own path builders plus the hand-built detour/step-corner paths);
 * anything else passes through untouched. `amplitude === 0 && bow === 0` is the identity
 * function, so Clean's line is byte-for-byte what it always was.
 *
 * `bow` is a second, independent pass: it adds a perpendicular mid-segment curve to every
 * straight `L` run by converting it into a `Q` through a new offset control point — it never
 * moves an existing point, only inserts one. This is what makes a `routing: 'straight'` connector
 * (a bare two-point `M ... L ...`, with no intermediate point for the `amplitude` pass above to
 * touch at all — its single point is simultaneously "first" and "last") wobble for the first
 * time; `Q`/`C` segments are left to the `amplitude` pass alone, since they're already curved.
 */
export function roughenPath(d: string, seedId: string, amplitude: number, bow = 0): string {
  if (amplitude === 0 && bow === 0) return d;
  const segments = parseSegments(d);
  if (segments.length === 0) return d;

  if (amplitude > 0) {
    const points: { segIndex: number; at: number }[] = [];
    segments.forEach((segment, segIndex) => {
      for (let i = 0; i + 1 < segment.nums.length; i += 2) points.push({ segIndex, at: i });
    });

    if (points.length > 1) {
      let seedIndex = 0;
      points.forEach((point, i) => {
        if (i === 0 || i === points.length - 1) return;
        const segment = segments[point.segIndex]!;
        segment.nums[point.at] = segment.nums[point.at]! + jitter(seedId, seedIndex, amplitude);
        segment.nums[point.at + 1] = segment.nums[point.at + 1]! + jitter(seedId, seedIndex + 1, amplitude);
        seedIndex += 2;
      });
    }
  }

  if (bow > 0) {
    // A large, disjoint seed-index band (starting at 1000) — well clear of anything the
    // `amplitude` pass above could reach even on the most elaborate detour path — so the two
    // passes can never accidentally correlate.
    let current = segmentEndpoint(segments[0]!);
    let bowIndex = 0;
    for (let s = 1; s < segments.length; s += 1) {
      const segment = segments[s]!;
      const end = segmentEndpoint(segment);
      if (segment.cmd === 'L') {
        const c = bowControlPoint(current, end, seedId, 1000 + bowIndex, bow);
        segment.cmd = 'Q';
        segment.nums = [c.x, c.y, end.x, end.y];
        bowIndex += 1;
      }
      current = end;
    }
  }

  return segments
    .map((segment) => `${segment.cmd}${segment.nums.map((value) => Math.round(value * 100) / 100).join(' ')}`)
    .join('');
}
