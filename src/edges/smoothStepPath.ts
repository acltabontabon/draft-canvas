import { Position } from '@xyflow/react';

/**
 * The stepped path between two anchors: out of each side by `offset`, then one or two turns.
 *
 * This is React Flow's `getSmoothStepPath` as `@xyflow/system` 0.0.83 shipped it (MIT, © webkid
 * GmbH; the licence is in `THIRD_PARTY_LICENSES.txt`), kept here because the router is built on the
 * exact points it emits. It names the stub at each end even when that stub runs straight on into
 * the next segment, and everything after it reads those points: where a line may turn, how much
 * straight run an arrowhead has, where a caption sits, which lines cross. Later versions of the
 * library drop a point that lies on a straight run, which draws the same line and moves all of
 * that. So the library can change its edges without changing a single route here.
 *
 * Do not "simplify" the points: `tests/routing-quality.test.ts` holds every route to its snapshot.
 */

interface Point {
  x: number;
  y: number;
}

export interface SmoothStepPathParams {
  sourceX: number;
  sourceY: number;
  sourcePosition?: Position;
  targetX: number;
  targetY: number;
  targetPosition?: Position;
  borderRadius?: number;
  centerX?: number;
  centerY?: number;
  offset?: number;
  stepPosition?: number;
}

const handleDirections: Record<Position, Point> = {
  [Position.Left]: { x: -1, y: 0 },
  [Position.Right]: { x: 1, y: 0 },
  [Position.Top]: { x: 0, y: -1 },
  [Position.Bottom]: { x: 0, y: 1 },
};

function directionOf(source: Point, sourcePosition: Position, target: Point): Point {
  if (sourcePosition === Position.Left || sourcePosition === Position.Right) {
    return source.x < target.x ? { x: 1, y: 0 } : { x: -1, y: 0 };
  }
  return source.y < target.y ? { x: 0, y: 1 } : { x: 0, y: -1 };
}

const distance = (a: Point, b: Point) => Math.sqrt(Math.pow(b.x - a.x, 2) + Math.pow(b.y - a.y, 2));

function pointsOf(
  source: Point,
  sourcePosition: Position,
  target: Point,
  targetPosition: Position,
  center: { x?: number; y?: number },
  offset: number,
  stepPosition: number,
): [points: Point[], labelX: number, labelY: number, offsetX: number, offsetY: number] {
  const sourceDir = handleDirections[sourcePosition];
  const targetDir = handleDirections[targetPosition];
  const sourceGapped = { x: source.x + sourceDir.x * offset, y: source.y + sourceDir.y * offset };
  const targetGapped = { x: target.x + targetDir.x * offset, y: target.y + targetDir.y * offset };
  const dir = directionOf(sourceGapped, sourcePosition, targetGapped);
  const dirAccessor = dir.x !== 0 ? 'x' : 'y';
  const currDir = dir[dirAccessor];
  let points: [Point, ...Point[]];
  let centerX: number;
  let centerY: number;
  const sourceGapOffset = { x: 0, y: 0 };
  const targetGapOffset = { x: 0, y: 0 };
  const defaultOffsetX = Math.abs(target.x - source.x) / 2;
  const defaultOffsetY = Math.abs(target.y - source.y) / 2;

  if (sourceDir[dirAccessor] * targetDir[dirAccessor] === -1) {
    // Opposite sides, the usual case.
    if (dirAccessor === 'x') {
      centerX = center.x ?? sourceGapped.x + (targetGapped.x - sourceGapped.x) * stepPosition;
      centerY = center.y ?? (sourceGapped.y + targetGapped.y) / 2;
    } else {
      centerX = center.x ?? (sourceGapped.x + targetGapped.x) / 2;
      centerY = center.y ?? sourceGapped.y + (targetGapped.y - sourceGapped.y) * stepPosition;
    }
    const verticalSplit: [Point, Point] = [
      { x: centerX, y: sourceGapped.y },
      { x: centerX, y: targetGapped.y },
    ];
    const horizontalSplit: [Point, Point] = [
      { x: sourceGapped.x, y: centerY },
      { x: targetGapped.x, y: centerY },
    ];
    if (sourceDir[dirAccessor] === currDir) {
      points = dirAccessor === 'x' ? verticalSplit : horizontalSplit;
    } else {
      points = dirAccessor === 'x' ? horizontalSplit : verticalSplit;
    }
  } else {
    // `sourceTarget` takes x from the source and y from the target; `targetSource` the other way.
    const sourceTarget: [Point] = [{ x: sourceGapped.x, y: targetGapped.y }];
    const targetSource: [Point] = [{ x: targetGapped.x, y: sourceGapped.y }];
    if (dirAccessor === 'x') {
      points = sourceDir.x === currDir ? targetSource : sourceTarget;
    } else {
      points = sourceDir.y === currDir ? sourceTarget : targetSource;
    }
    if (sourcePosition === targetPosition) {
      const diff = Math.abs(source[dirAccessor] - target[dirAccessor]);
      // Same side at both ends and closer than the stub: the added point and a gapped end would
      // overlap, so that end's stub is pulled back.
      if (diff <= offset) {
        const gapOffset = Math.min(offset - 1, offset - diff);
        if (sourceDir[dirAccessor] === currDir) {
          sourceGapOffset[dirAccessor] = (sourceGapped[dirAccessor] > source[dirAccessor] ? -1 : 1) * gapOffset;
        } else {
          targetGapOffset[dirAccessor] = (targetGapped[dirAccessor] > target[dirAccessor] ? -1 : 1) * gapOffset;
        }
      }
    }
    // Mixed sides, such as right into bottom.
    if (sourcePosition !== targetPosition) {
      const dirAccessorOpposite = dirAccessor === 'x' ? 'y' : 'x';
      const isSameDir = sourceDir[dirAccessor] === targetDir[dirAccessorOpposite];
      const sourceGtTargetOppo = sourceGapped[dirAccessorOpposite] > targetGapped[dirAccessorOpposite];
      const sourceLtTargetOppo = sourceGapped[dirAccessorOpposite] < targetGapped[dirAccessorOpposite];
      const flipSourceTarget =
        (sourceDir[dirAccessor] === 1 && ((!isSameDir && sourceGtTargetOppo) || (isSameDir && sourceLtTargetOppo))) ||
        (sourceDir[dirAccessor] !== 1 && ((!isSameDir && sourceLtTargetOppo) || (isSameDir && sourceGtTargetOppo)));
      if (flipSourceTarget) {
        points = dirAccessor === 'x' ? sourceTarget : targetSource;
      }
    }
    const sourceGapPoint = { x: sourceGapped.x + sourceGapOffset.x, y: sourceGapped.y + sourceGapOffset.y };
    const targetGapPoint = { x: targetGapped.x + targetGapOffset.x, y: targetGapped.y + targetGapOffset.y };
    const maxXDistance = Math.max(Math.abs(sourceGapPoint.x - points[0].x), Math.abs(targetGapPoint.x - points[0].x));
    const maxYDistance = Math.max(Math.abs(sourceGapPoint.y - points[0].y), Math.abs(targetGapPoint.y - points[0].y));
    // The label goes on the longer run.
    if (maxXDistance >= maxYDistance) {
      centerX = (sourceGapPoint.x + targetGapPoint.x) / 2;
      centerY = points[0].y;
    } else {
      centerX = points[0].x;
      centerY = (sourceGapPoint.y + targetGapPoint.y) / 2;
    }
  }

  const gappedSource = { x: sourceGapped.x + sourceGapOffset.x, y: sourceGapped.y + sourceGapOffset.y };
  const gappedTarget = { x: targetGapped.x + targetGapOffset.x, y: targetGapped.y + targetGapOffset.y };
  const first = points[0];
  const last = points[points.length - 1] ?? first;
  const pathPoints = [
    source,
    // A gapped end that is the first or last point already would be a duplicate, which breaks the bends.
    ...(gappedSource.x !== first.x || gappedSource.y !== first.y ? [gappedSource] : []),
    ...points,
    ...(gappedTarget.x !== last.x || gappedTarget.y !== last.y ? [gappedTarget] : []),
    target,
  ];
  return [pathPoints, centerX, centerY, defaultOffsetX, defaultOffsetY];
}

function bendOf(a: Point, b: Point, c: Point, size: number): string {
  const bendSize = Math.min(distance(a, b) / 2, distance(b, c) / 2, size);
  const { x, y } = b;
  // No bend.
  if ((a.x === x && x === c.x) || (a.y === y && y === c.y)) {
    return `L${x} ${y}`;
  }
  // The first segment is horizontal.
  if (a.y === y) {
    const xDir = a.x < c.x ? -1 : 1;
    const yDir = a.y < c.y ? 1 : -1;
    return `L ${x + bendSize * xDir},${y}Q ${x},${y} ${x},${y + bendSize * yDir}`;
  }
  const xDir = a.x < c.x ? 1 : -1;
  const yDir = a.y < c.y ? -1 : 1;
  return `L ${x},${y + bendSize * yDir}Q ${x},${y} ${x + bendSize * xDir},${y}`;
}

/** The path, where its label goes, and the offsets from the source to that label. */
export function getSmoothStepPath({
  sourceX,
  sourceY,
  sourcePosition = Position.Bottom,
  targetX,
  targetY,
  targetPosition = Position.Top,
  borderRadius = 5,
  centerX,
  centerY,
  offset = 20,
  stepPosition = 0.5,
}: SmoothStepPathParams): [path: string, labelX: number, labelY: number, offsetX: number, offsetY: number] {
  const source = { x: sourceX, y: sourceY };
  const target = { x: targetX, y: targetY };
  const [points, labelX, labelY, offsetX, offsetY] = pointsOf(
    source,
    sourcePosition,
    target,
    targetPosition,
    { x: centerX, y: centerY },
    offset,
    stepPosition,
  );
  let path = `M${source.x} ${source.y}`;
  for (let i = 1; i < points.length - 1; i++) {
    path += bendOf(points[i - 1]!, points[i]!, points[i + 1]!, borderRadius);
  }
  path += `L${target.x} ${target.y}`;
  return [path, labelX, labelY, offsetX, offsetY];
}
