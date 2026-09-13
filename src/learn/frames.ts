import { createEdge, createNode } from '../document/factory';
import type { DraftEdge, DraftNode } from '../document/types';
import type { Scene, SceneCursor, SceneOverlay } from './types';

/**
 * A scene is authored as patches (what changes at each beat); a renderer wants whole states (what
 * is on stage right now). Folding once, up front, keeps both honest: authoring stays short, and any
 * frame can be drawn on its own — which is what lets a step chip jump straight to it, and reduced
 * motion show the final state without playing anything.
 */
export interface ResolvedFrame {
  index: number;
  ms: number;
  /** Index into `ResolvedScene.steps`. */
  step: number;
  nodes: readonly DraftNode[];
  edges: readonly DraftEdge[];
  selection: ReadonlySet<string>;
  handles: string | null;
  cursor: SceneCursor | null;
  overlay: SceneOverlay | null;
  dim: ReadonlySet<string>;
  ghost: ReadonlySet<string>;
  moving: ReadonlySet<string>;
  chips: Readonly<Record<string, readonly ('note' | 'code')[]>>;
  flow: readonly string[];
}

export interface ResolvedScene {
  frames: readonly ResolvedFrame[];
  /** Step labels, in order of first appearance. */
  steps: readonly string[];
}

const EMPTY: ReadonlySet<string> = new Set();

export function resolveScene(scene: Scene): ResolvedScene {
  const nodes = new Map<string, DraftNode>();
  const edges = new Map<string, DraftEdge>();
  let selection: ReadonlySet<string> = EMPTY;
  let handles: string | null = null;
  let cursor: SceneCursor | null = null;
  let chips: Readonly<Record<string, readonly ('note' | 'code')[]>> = {};
  let flow: readonly string[] = [];
  const steps: string[] = [];
  const frames: ResolvedFrame[] = [];

  scene.frames.forEach((frame, index) => {
    for (const id of frame.remove ?? []) {
      nodes.delete(id);
      edges.delete(id);
      for (const [edgeId, edge] of edges) if (edge.source === id || edge.target === id) edges.delete(edgeId);
    }
    for (const spec of frame.add?.nodes ?? []) nodes.set(spec.id, createNode(spec));
    for (const spec of frame.add?.edges ?? []) edges.set(spec.id, createEdge(spec));
    for (const [id, patch] of Object.entries(frame.update?.nodes ?? {})) {
      const node = nodes.get(id);
      if (node) nodes.set(id, { ...node, ...patch });
    }
    for (const [id, patch] of Object.entries(frame.update?.edges ?? {})) {
      const edge = edges.get(id);
      if (edge) edges.set(id, { ...edge, ...patch });
    }

    if (frame.select) selection = new Set(frame.select);
    if (frame.handles !== undefined) handles = frame.handles;
    if (frame.chips) chips = { ...chips, ...frame.chips };
    if (frame.flow) flow = frame.flow;
    // A click is one beat's event, not a state: the next beat keeps the pointer where it is.
    if (frame.cursor !== undefined) cursor = frame.cursor;
    else if (cursor) cursor = { x: cursor.x, y: cursor.y, down: cursor.down };

    if (frame.step && steps[steps.length - 1] !== frame.step) steps.push(frame.step);

    frames.push({
      index,
      ms: frame.ms,
      step: Math.max(0, steps.length - 1),
      nodes: [...nodes.values()],
      edges: [...edges.values()].filter((edge) => nodes.has(edge.source) && nodes.has(edge.target)),
      selection,
      handles,
      cursor,
      overlay: frame.overlay ?? null,
      dim: frame.dim ? new Set(frame.dim) : EMPTY,
      ghost: frame.ghost ? new Set(frame.ghost) : EMPTY,
      moving: frame.moving ? new Set(frame.moving) : EMPTY,
      chips,
      flow,
    });
  });

  return { frames, steps };
}

/** The first frame of each step — where a step chip jumps to. */
export function stepStarts(resolved: ResolvedScene): number[] {
  const starts: number[] = [];
  for (const frame of resolved.frames) if (starts[frame.step] === undefined) starts[frame.step] = frame.index;
  return starts;
}
