import type { SceneEdgeSpec, SceneNodeSpec, ScenePoint } from '../types';

/**
 * Shorthand for authoring scenes. Sizes are a touch smaller than the canvas defaults so a small
 * system fits the 560 × 350 stage and still reads as Draft Canvas at drawer width.
 */

type Extra = Partial<Omit<SceneNodeSpec, 'id' | 'type' | 'x' | 'y'>>;

export const service = (id: string, x: number, y: number, text: string, extra: Extra = {}): SceneNodeSpec => ({
  id,
  type: 'service',
  x,
  y,
  width: 144,
  height: 58,
  text,
  ...extra,
});

export const store = (id: string, x: number, y: number, text: string, extra: Extra = {}): SceneNodeSpec => ({
  id,
  type: 'database',
  x,
  y,
  width: 124,
  height: 80,
  text,
  ...extra,
});

/** A queue with no name is the canvas default: just the tube and its kind caption. */
export const queue = (id: string, x: number, y: number, text = '', extra: Extra = {}): SceneNodeSpec => ({
  id,
  type: 'queue',
  x,
  y,
  width: 128,
  height: text ? 72 : 48,
  text,
  ...extra,
});

export const junction = (id: string, x: number, y: number): SceneNodeSpec => ({
  id,
  type: 'ellipse',
  x,
  y,
  width: 28,
  height: 28,
  text: '',
});

export const edge = (id: string, source: string, target: string, extra: Partial<SceneEdgeSpec> = {}): SceneEdgeSpec => ({
  id,
  source,
  target,
  ...extra,
});

/** The middle of a node spec — where a click on it lands. */
export const middle = (node: SceneNodeSpec): ScenePoint => ({
  x: node.x + (node.width ?? 0) / 2,
  y: node.y + (node.height ?? 0) / 2,
});

/** Just past the cursor's rest position, off to the lower right — where a scene's pointer starts. */
export const REST: ScenePoint = { x: 300, y: 318 };
