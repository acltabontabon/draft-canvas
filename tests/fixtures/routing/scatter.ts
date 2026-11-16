/**
 * Diagrams the way a person draws them before tidying anything: shapes dropped roughly on a grid,
 * a little out of line, and connectors added one at a time — most to a neighbour, some right across
 * the canvas. The curated corpus (starters, the gallery, the workloads) is laid out to be read;
 * this is where a connector first meets other connectors and shapes it has to share the canvas with.
 *
 * Seeded and deterministic: the same seed is always the same diagram.
 */

import { createEdge, createNode } from '../../../src/document/factory';
import type { DraftEdge, DraftNode } from '../../../src/document/types';

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TYPES = ['service', 'service', 'service', 'database', 'queue', 'actor', 'component'] as const;
/** Grid pitch and jitter: the widest shape still leaves a gap of two dozen pixels to its neighbour. */
const PITCH = { x: 290, y: 210 };
const JITTER = { x: 80, y: 60 };

/**
 * `count` shapes and about one and a half connectors each. `far` is how often a shape gets a second
 * connector to anywhere on the canvas rather than only to one of its three nearest neighbours.
 */
export function scatter(seed: number, count = 9, far = 0.5): { nodes: DraftNode[]; edges: DraftEdge[] } {
  const next = random(seed);
  const columns = Math.ceil(Math.sqrt(count * 1.6));
  const rows = Math.ceil((count * 1.4) / columns);
  const cells: [number, number][] = [];
  for (let column = 0; column < columns; column += 1) for (let row = 0; row < rows; row += 1) cells.push([column, row]);
  for (let i = cells.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [cells[i], cells[j]] = [cells[j]!, cells[i]!];
  }
  const nodes = cells.slice(0, count).map(([column, row], i) => createNode({
    id: `n${i}`,
    type: TYPES[Math.floor(next() * TYPES.length)]!,
    x: column * PITCH.x + Math.round((next() - 0.5) * JITTER.x),
    y: row * PITCH.y + Math.round((next() - 0.5) * JITTER.y),
    text: `N${i}`,
  }));
  const edges: DraftEdge[] = [];
  const joined = new Set<string>();
  const join = (a: number, b: number) => {
    if (a === b) return;
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (joined.has(key)) return;
    joined.add(key);
    edges.push(createEdge({ id: `e${edges.length}`, source: `n${a}`, target: `n${b}`, ...(next() < 0.3 ? { label: 'calls' } : {}) }));
  };
  for (let i = 0; i < count; i += 1) {
    const [column, row] = cells[i]!;
    const nearest = nodes.map((_, j) => j).filter((j) => j !== i).sort((a, b) =>
      Math.hypot(cells[a]![0] - column, cells[a]![1] - row) - Math.hypot(cells[b]![0] - column, cells[b]![1] - row));
    join(i, nearest[Math.floor(next() * 3)]!);
    if (next() < far) join(i, nearest[Math.floor(next() * nearest.length)]!);
  }
  return { nodes, edges };
}
