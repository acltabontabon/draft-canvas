import { describe, expect, it } from 'vitest';
import { createDocument } from '../src/document/factory';
import type { DraftEdge, DraftNode } from '../src/document/types';
import { crossedBoundaries, flowOverviewBounds, stepComposition } from '../src/presentation/composition';
import { stepContextOf } from '../src/presentation/stepContext';
import type { FlowPlaybackStep } from '../src/presentation/useFlowPlayback';

/**
 * What a step is a picture of: its shapes, the connector as drawn, and — when the interaction
 * leaves one boundary for another — the boundary itself, whole when it fits and by its named
 * header when it doesn't. Nothing here invents architecture: a crossing is read straight from
 * `parentId`, and a step inside one boundary crosses nothing.
 */
function node(id: string, x: number, y: number, extra: Partial<DraftNode> = {}): DraftNode {
  return { id, type: 'service', x, y, width: 176, height: 68, z: 1, ...extra };
}

function boundary(id: string, x: number, y: number, width: number, height: number, parentId?: string): DraftNode {
  return { id, type: 'group', x, y, width, height, z: 0, ...(parentId ? { parentId } : {}) };
}

function edge(id: string, source: string, target: string): DraftEdge {
  return { id, source, target, directed: true, routing: 'smoothstep' };
}

function step(edges: DraftEdge[], extraNodes: DraftNode[] = []): FlowPlaybackStep {
  return { edge: edges[0], edges, extraNodes, index: 0, step: 1 };
}

const byId = (nodes: DraftNode[]) => new Map(nodes.map((n) => [n.id, n]));

describe('crossedBoundaries', () => {
  it('finds nothing between two shapes in the same place, including the top level', () => {
    const nodes = byId([node('a', 0, 0), node('b', 400, 0)]);
    expect(crossedBoundaries(nodes, 'a', 'b')).toEqual([]);
    const inside = byId([boundary('g', 0, 0, 800, 300), node('a', 20, 40, { parentId: 'g' }), node('b', 400, 40, { parentId: 'g' })]);
    expect(crossedBoundaries(inside, 'a', 'b')).toEqual([]);
  });

  it('names the boundary being left and the one being entered, outermost first', () => {
    const nodes = byId([
      boundary('outer', 0, 0, 2000, 1000),
      boundary('inner', 20, 20, 600, 400, 'outer'),
      boundary('other', 1000, 20, 600, 400),
      node('a', 40, 60, { parentId: 'inner' }),
      node('b', 1040, 60, { parentId: 'other' }),
    ]);
    expect(crossedBoundaries(nodes, 'a', 'b').map((n) => n.id)).toEqual(['outer', 'inner', 'other']);
  });

  it('survives a cyclic parent chain in a hand-edited file', () => {
    const nodes = byId([boundary('g1', 0, 0, 100, 100, 'g2'), boundary('g2', 0, 0, 100, 100, 'g1'), node('a', 0, 0, { parentId: 'g1' }), node('b', 0, 0)]);
    expect(crossedBoundaries(nodes, 'a', 'b').map((n) => n.id)).toEqual(['g2', 'g1']);
  });
});

describe('stepComposition', () => {
  it('frames the endpoints, and the connector as drawn when the canvas measured it', () => {
    const nodes = [node('a', 0, 0), node('b', 400, 300)];
    const s = step([edge('e', 'a', 'b')]);
    expect(stepComposition(s, byId(nodes))!.bounds).toEqual({ x: 0, y: 0, width: 576, height: 368 });
    const routes = new Map([['e', { x: 100, y: -80, width: 300, height: 100 }]]);
    expect(stepComposition(s, byId(nodes), routes)!.bounds).toEqual({ x: 0, y: -80, width: 576, height: 448 });
  });

  it('takes a small crossed boundary whole, and a large one by its header', () => {
    const small = [boundary('g', 380, 280, 260, 140), node('a', 0, 0), node('b', 420, 320, { parentId: 'g' })];
    const whole = stepComposition(step([edge('e', 'a', 'b')]), byId(small))!;
    expect(whole.crossed).toEqual(['g']);
    expect(whole.bounds).toEqual({ x: 0, y: 0, width: 640, height: 420 });

    const large = [boundary('g', 380, 280, 3000, 2000), node('a', 0, 0), node('b', 420, 320, { parentId: 'g' })];
    const header = stepComposition(step([edge('e', 'a', 'b')]), byId(large))!;
    // The header strip (260 wide, 44 tall from the boundary's corner) joins; the rest does not.
    expect(header.bounds).toEqual({ x: 0, y: 0, width: 640, height: 388 });
  });

  it('leaves a boundary out entirely when even its header would push the camera too far', () => {
    const nodes = [boundary('g', 2000, 2000, 3000, 2000), node('a', 0, 0), node('b', 2100, 2100, { parentId: 'g' })];
    const composed = stepComposition(step([edge('e', 'a', 'b')]), byId(nodes))!;
    expect(composed.crossed).toEqual(['g']);
    expect(composed.bounds).toEqual({ x: 0, y: 0, width: 2276, height: 2168 });
  });

  it('reads sources and targets across a parallel step', () => {
    const nodes = [node('a', 0, 0), node('b', 400, 0), node('c', 400, 200)];
    const composed = stepComposition(step([edge('e1', 'a', 'b'), edge('e2', 'a', 'c')]), byId(nodes))!;
    expect(composed.sources).toEqual(['a', 'a']);
    expect(composed.targets).toEqual(['b', 'c']);
  });

  it('is nothing for a step with nothing on stage', () => {
    expect(stepComposition({ edges: [], extraNodes: [], index: 0, step: 1, viewport: { x: 0, y: 0, zoom: 1 } }, byId([]))).toBeNull();
  });
});

describe('flowOverviewBounds', () => {
  it('spans every member with the boundaries that hold them', () => {
    const nodes = [boundary('g', -40, -40, 800, 300), node('a', 0, 0, { parentId: 'g' }), node('b', 400, 0, { parentId: 'g' }), node('far', 3000, 3000)];
    const edges = [edge('e', 'a', 'b'), edge('unused', 'b', 'far')];
    const flow = { id: 'f', title: 'Flow', steps: [{ id: 's1', edgeId: 'e' }] };
    expect(flowOverviewBounds(nodes, edges, flow)).toEqual({ x: -40, y: -40, width: 800, height: 300 });
  });
});

describe('stepContextOf', () => {
  it('answers who the step leaves from and arrives at, once per document and playback', () => {
    const document = createDocument('Context');
    document.nodes = [boundary('g', 380, 280, 260, 140), node('a', 0, 0), node('b', 420, 320, { parentId: 'g' })];
    document.edges = [edge('e', 'a', 'b')];
    document.flows = [{ id: 'f', title: 'Flow', steps: [{ id: 's1', edgeId: 'e' }] }];
    const flowPlayback = { active: true, flowId: 'f', step: 1 };
    const context = stepContextOf({ document, flowPlayback })!;
    expect([...context.sources]).toEqual(['a']);
    expect([...context.targets]).toEqual(['b']);
    expect([...context.crossed]).toEqual(['g']);
    expect(context.transitionKey).toBe('f:1:request');
    expect(stepContextOf({ document, flowPlayback })).toBe(context);
    // The reply half is its own transition, and it arrives back at the caller.
    const reply = stepContextOf({ document, flowPlayback: { ...flowPlayback, phase: 'response' } })!;
    expect(reply.transitionKey).toBe('f:1:response');
    expect([...reply.sources]).toEqual(['b']);
    expect([...reply.targets]).toEqual(['a']);
    expect([...reply.crossed]).toEqual(['g']);
  });

  it('has no step context in an overview or with nothing playing', () => {
    const document = createDocument('Context');
    expect(stepContextOf({ document, flowPlayback: { active: false, flowId: null, step: 0 } })).toBeNull();
    expect(stepContextOf({ document, flowPlayback: { active: true, flowId: 'f', step: 0, stage: 'opening' } })).toBeNull();
  });
});
