import { CONNECTOR_STYLE } from '../connectorStyle';
import { headPath } from '../svg/markers';

/** Place the shared nib on a precise endpoint. Only its back wobbles, never the target. */
export function sketchArrowPath(
  tip: { x: number; y: number },
  dir: { x: number; y: number },
  seedId: string,
  amplitude: number,
  variant: 'closed' | 'open' = 'closed',
): string {
  return headPath(variant, seedId, amplitude).replace(/(-?\d*\.?\d+) (-?\d*\.?\d+)/g, (_, sx, sy) => {
    const x = Number(sx) - CONNECTOR_STYLE.arrowLength;
    const y = Number(sy) - CONNECTOR_STYLE.arrowWidth / 2;
    return `${tip.x + dir.x * x - dir.y * y} ${tip.y + dir.y * x + dir.x * y}`;
  });
}
