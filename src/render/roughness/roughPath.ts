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

/**
 * Perturbs an already-routed path's intermediate points (endpoints and
 * control points alike), leaving the very first and very last point exactly
 * where `route.d` put them — a connector's actual attachment coordinates
 * never move, only the line drawn between them wobbles. Only handles the
 * `M`/`L`/`Q`/`C`, all-absolute-uppercase command set `edges/routing.ts`
 * actually produces (React Flow's own path builders plus the hand-built
 * detour/step-corner paths) — anything else passes through untouched.
 * `amplitude === 0` is the identity function, so Clean's line is byte-for-
 * byte what it always was.
 */
export function roughenPath(d: string, seedId: string, amplitude: number): string {
  if (amplitude === 0) return d;
  const segments = parseSegments(d);
  if (segments.length === 0) return d;

  const points: { segIndex: number; at: number }[] = [];
  segments.forEach((segment, segIndex) => {
    for (let i = 0; i + 1 < segment.nums.length; i += 2) points.push({ segIndex, at: i });
  });
  if (points.length <= 1) return d;

  let seedIndex = 0;
  points.forEach((point, i) => {
    if (i === 0 || i === points.length - 1) return;
    const segment = segments[point.segIndex]!;
    segment.nums[point.at] = segment.nums[point.at]! + jitter(seedId, seedIndex, amplitude);
    segment.nums[point.at + 1] = segment.nums[point.at + 1]! + jitter(seedId, seedIndex + 1, amplitude);
    seedIndex += 2;
  });

  return segments
    .map((segment) => `${segment.cmd}${segment.nums.map((value) => Math.round(value * 100) / 100).join(' ')}`)
    .join('');
}
