import { describe, expect, it } from 'vitest';
import { resolveSelectedEdgeIds } from '../src/canvas/projection';

/** Minimal edge shape `resolveSelectedEdgeIds` actually reads. */
function edge(id: string, source: string, target: string) {
  return { id, source, target };
}

describe('resolveSelectedEdgeIds', () => {
  it('derives connected edges from the document when a marquee spans two or more nodes, ignoring a bogus report', () => {
    // Regression test: two edges sharing node A (A-B, A-C) marquee-selected together used to
    // crash the app — React Flow's own post-gesture edge-selection report for this exact shape
    // never settles, alternating between empty and both edges forever. `reportedEdgeIds` here is
    // deliberately wrong (empty) to prove the result comes from the document, not from trusting
    // that oscillating report.
    const documentEdges = [edge('e1', 'a', 'b'), edge('e2', 'a', 'c')];
    const result = resolveSelectedEdgeIds(['a', 'b', 'c'], [], [], documentEdges);
    expect(result.sort()).toEqual(['e1', 'e2']);
  });

  it('derives an empty edge set when a multi-node marquee is released back to no nodes', () => {
    // Regression test: two back-to-back marquees over the same connected pair used to leave a
    // stale edge selected — releasing (or replacing) a multi-node selection is exactly as
    // ambiguous as forming one, so the *previous* node count alone must trigger the same
    // document-derived (not React-Flow-reported) resolution.
    const documentEdges = [edge('e1', 'a', 'b')];
    const result = resolveSelectedEdgeIds([], ['a', 'b'], ['e1'], documentEdges);
    expect(result).toEqual([]);
  });

  it('trusts the reported edges for an ordinary single edge click, with no node ever involved', () => {
    const documentEdges = [edge('e1', 'a', 'b')];
    const result = resolveSelectedEdgeIds([], [], ['e1'], documentEdges);
    expect(result).toEqual(['e1']);
  });

  it('trusts the reported (empty) edges when a plain node click follows a single selected edge', () => {
    // A lone selected node can never be "both endpoints" of a real edge, so the derived path
    // would also resolve to `[]` here — this asserts the *reported* value specifically still
    // flows through unmodified for this non-ambiguous case.
    const documentEdges = [edge('e1', 'a', 'b')];
    const result = resolveSelectedEdgeIds(['a'], [], [], documentEdges);
    expect(result).toEqual([]);
  });

  it('never reports an edge whose other endpoint is outside the selected node set', () => {
    const documentEdges = [edge('e1', 'a', 'b'), edge('e2', 'b', 'c')];
    const result = resolveSelectedEdgeIds(['a', 'b'], [], [], documentEdges);
    expect(result).toEqual(['e1']);
  });
});
