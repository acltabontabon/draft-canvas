import { describe, expect, it } from 'vitest';
import { canvasChange, CHANGE_FEEDBACK_LIMIT, historyStep } from '../src/canvas/changeFeedback';
import type { DraftEdge, DraftNode } from '../src/document/types';
import type { HistoryEntry, HistoryState } from '../src/history/HistoryStack';

const node = (id: string, x = 0, y = 0, text = id) => ({ id, type: 'service', x, y, text }) as unknown as DraftNode;
const edge = (id: string, source: string, target: string, extra: Partial<DraftEdge> = {}) =>
  ({ id, source, target, ...extra }) as unknown as DraftEdge;
const entry = (label: string) => ({ label }) as unknown as HistoryEntry;

describe('historyStep', () => {
  const a = entry('a');
  const b = entry('b');

  it('tells an undo, a redo and an ordinary edit apart', () => {
    const before: HistoryState = { past: [a, b], future: [] };
    const undone: HistoryState = { past: [a], future: [b] };
    expect(historyStep(before, undone)).toBe('undo');
    expect(historyStep(undone, before)).toBe('redo');
    // A new edit after an undo also shortens the future and lengthens the past — but with a new entry.
    expect(historyStep(undone, { past: [a, entry('c')], future: [] })).toBeNull();
    expect(historyStep(before, before)).toBeNull();
  });
});

describe('canvasChange', () => {
  it('returns nothing for a drag, which keeps every list the same length', () => {
    const prev = { nodes: [node('a'), node('b')], edges: [edge('e', 'a', 'b')] };
    const next = { nodes: [node('a', 40, 0), prev.nodes[1]!], edges: prev.edges };
    expect(canvasChange(prev, next, null)).toBeNull();
  });

  it('reports what arrived and what left', () => {
    const a = node('a');
    const prev = { nodes: [a, node('b')], edges: [edge('e', 'a', 'b')] };
    const next = { nodes: [a, node('c')], edges: [edge('f', 'a', 'c')] };
    expect(canvasChange(prev, next, null)).toMatchObject({
      arrivedNodes: ['c'],
      departedNodes: ['b'],
      arrivedEdges: ['f'],
      departedEdges: ['e'],
      movedNodes: [],
      changedNodes: [],
    });
  });

  it('on undo or redo, separates moved shapes from ones changed in place and ignores the untouched', () => {
    const still = node('still');
    const e = edge('e', 'moved', 'still');
    const prev = { nodes: [node('moved'), node('renamed'), still], edges: [e, edge('bent', 'moved', 'still', { waypoints: [] })] };
    const next = {
      nodes: [node('moved', 80, 20), node('renamed', 0, 0, 'New name'), still],
      edges: [e, edge('bent', 'moved', 'still', { waypoints: [{ x: 1, y: 2 }] } as unknown as Partial<DraftEdge>)],
    };
    const change = canvasChange(prev, next, 'undo');
    expect(change?.movedNodes).toEqual(['moved']);
    expect(change?.changedNodes).toEqual(['renamed']);
    // Only its bends differ: it followed the shape that moved, and the glide already says so.
    expect(change?.changedEdges).toEqual([]);
  });

  it('shows nothing for a change too large to read, such as a big paste', () => {
    const prev = { nodes: [], edges: [] };
    const next = { nodes: Array.from({ length: CHANGE_FEEDBACK_LIMIT + 1 }, (_, i) => node(`n${i}`)), edges: [] };
    expect(canvasChange(prev, next, null)).toBeNull();
  });
});
