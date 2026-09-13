import type { CSSProperties } from 'react';
import type { ScenePoint } from '../../learn/types';

/** Absolute placement in stage units (`--u`, one 560th of the stage's width — see `learn.css`). */
export function at(point: ScenePoint): CSSProperties {
  return { left: `calc(${point.x} * var(--u))`, top: `calc(${point.y} * var(--u))` };
}
