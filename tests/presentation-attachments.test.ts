import { describe, expect, it } from 'vitest';
import type { DraftEdge, DraftFlow, DraftNode } from '../src/document/types';
import {
  describePresentationSubject,
  presentableAttachments,
  presentationScope,
  resolvePresentationSubject,
  revealedSubject,
  toggledReveal,
} from '../src/presentation/presentationAttachments';
import { resolveFlowSteps } from '../src/presentation/useFlowPlayback';
import { buildStarter } from '../src/starters/build';
import { starterById } from '../src/starters';

function playbackOf(flow: DraftFlow, nodes: DraftNode[], edges: DraftEdge[]) {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const edgesById = new Map(edges.map((edge) => [edge.id, edge]));
  return { steps: resolveFlowSteps(flow, edges, nodes), nodesById, edgesById };
}

function node(id: string, extra: Partial<DraftNode> = {}): DraftNode {
  return { id, type: 'service', x: 0, y: 0, width: 100, height: 60, text: id, ...extra } as DraftNode;
}

function edge(id: string, source: string, target: string, extra: Partial<DraftEdge> = {}): DraftEdge {
  return { id, source, target, ...extra } as DraftEdge;
}

const note = (id: string, text: string) => ({ id, type: 'note' as const, text });

describe('resolvePresentationSubject', () => {
  it('lets the CQRS write story speak on arrival at Command API, on the publish edge, and at Read Store', () => {
    const { nodes, edges, flows } = buildStarter(starterById('cqrs')!, { x: 0, y: 0 });
    const flow = flows.find((candidate) => candidate.title === 'Submit command')!;
    const { steps, nodesById, edgesById } = playbackOf(flow, nodes, edges);
    const byText = (text: string) => nodes.find((candidate) => candidate.text === text)!;

    const spoken = steps.map((entry) =>
      resolvePresentationSubject({ flowId: flow.id, steps, step: entry.step, nodesById, edgesById }),
    );
    expect(spoken.map((subject) => (subject ? subject.hostKind : null))).toEqual(['node', null, null, 'edge', null, 'node']);
    expect(spoken[0]!.hostId).toBe(byText('Command API').id);
    expect(spoken[0]!.attachments[0]!.type).toBe('code');
    expect(spoken[3]!.attachments[0]!.text).toMatch(/^OrderPlaced/);
    expect(spoken[5]!.hostId).toBe(byText('Read Store').id);
    // The key is the step's identity — distinct per step, stable across calls.
    expect(new Set(spoken.filter(Boolean).map((subject) => subject!.key)).size).toBe(3);
  });

  it('prefers the connector over the node it arrives at', () => {
    const nodes = [node('a'), node('b', { attachments: [note('nb', 'about b')] })];
    const edges = [edge('ab', 'a', 'b', { attachments: [note('ne', 'about the call')] })];
    const flow: DraftFlow = { id: 'f', title: 'F', steps: [{ id: 's1', edgeId: 'ab' }] };
    const { steps, nodesById, edgesById } = playbackOf(flow, nodes, edges);
    const subject = resolvePresentationSubject({ flowId: 'f', steps, step: 1, nodesById, edgesById });
    expect(subject?.hostId).toBe('ab');
  });

  it('introduces a node only the first time the flow reaches it', () => {
    const nodes = [node('a'), node('b', { attachments: [note('nb', 'about b')] }), node('c')];
    const edges = [edge('ab', 'a', 'b'), edge('ba', 'b', 'a'), edge('cb', 'c', 'b')];
    const flow: DraftFlow = {
      id: 'f',
      title: 'F',
      steps: [
        { id: 's1', edgeId: 'ab' },
        { id: 's2', edgeId: 'ba' },
        { id: 's3', edgeId: 'cb' },
      ],
    };
    const { steps, nodesById, edgesById } = playbackOf(flow, nodes, edges);
    const at = (step: number) => resolvePresentationSubject({ flowId: 'f', steps, step, nodesById, edgesById });
    expect(at(1)?.hostId).toBe('b');
    expect(at(2)).toBeNull();
    expect(at(3)).toBeNull();
  });

  it('speaks for a frame step’s spotlighted nodes', () => {
    const nodes = [node('a'), node('b', { attachments: [note('nb', 'the boundary')] })];
    const flow: DraftFlow = { id: 'f', title: 'F', steps: [{ id: 's1', extraNodeIds: ['a', 'b'] }] };
    const { steps, nodesById, edgesById } = playbackOf(flow, nodes, []);
    expect(resolvePresentationSubject({ flowId: 'f', steps, step: 1, nodesById, edgesById })?.hostId).toBe('b');
  });

  it('lets a presenter reveal win, and ignores a reveal whose host is gone', () => {
    const nodes = [node('a', { attachments: [note('na', 'about a')] }), node('b')];
    const edges = [edge('ab', 'a', 'b', { attachments: [note('ne', 'about the call')] })];
    const flow: DraftFlow = { id: 'f', title: 'F', steps: [{ id: 's1', edgeId: 'ab' }] };
    const { steps, nodesById, edgesById } = playbackOf(flow, nodes, edges);
    const revealed = resolvePresentationSubject({
      flowId: 'f',
      steps,
      step: 1,
      nodesById,
      edgesById,
      reveal: { hostKind: 'node', hostId: 'a', scope: 'f:1' },
    });
    expect(revealed).toMatchObject({ hostKind: 'node', hostId: 'a' });
    const dangling = resolvePresentationSubject({
      flowId: 'f',
      steps,
      step: 1,
      nodesById,
      edgesById,
      reveal: { hostKind: 'node', hostId: 'gone', scope: 'f:1' },
    });
    expect(dangling?.hostId).toBe('ab');
  });

  it('ignores a reveal made on another step, even before anything clears it', () => {
    const nodes = [node('a', { attachments: [note('na', 'about a')] }), node('b'), node('c')];
    const edges = [edge('ab', 'a', 'b'), edge('bc', 'b', 'c', { attachments: [note('nc', 'about bc')] })];
    const flow: DraftFlow = { id: 'f', title: 'F', steps: [{ id: 's1', edgeId: 'ab' }, { id: 's2', edgeId: 'bc' }] };
    const { steps, nodesById, edgesById } = playbackOf(flow, nodes, edges);
    const scope = presentationScope({ active: true, flowId: 'f', step: 1 });
    const reveal = toggledReveal(null, 'node', 'a', scope);
    expect(resolvePresentationSubject({ flowId: 'f', steps, step: 1, nodesById, edgesById, reveal })?.hostId).toBe('a');
    // Stepped on: the stale reveal no longer speaks — the step's own connector does.
    expect(resolvePresentationSubject({ flowId: 'f', steps, step: 2, nodesById, edgesById, reveal })?.hostId).toBe('bc');
    // Asked again on the same moment, it lets go; with no flow the moment is 'present'.
    expect(toggledReveal(reveal, 'node', 'a', scope)).toBeNull();
    expect(presentationScope({ active: false, flowId: null, step: 0 })).toBe('present');
  });

  it('stays silent for empty attachments and steps outside the flow', () => {
    const nodes = [node('a'), node('b', { attachments: [note('nb', '   '), { id: 'c', type: 'code', code: '' }] })];
    const edges = [edge('ab', 'a', 'b')];
    const flow: DraftFlow = { id: 'f', title: 'F', steps: [{ id: 's1', edgeId: 'ab' }] };
    const { steps, nodesById, edgesById } = playbackOf(flow, nodes, edges);
    expect(resolvePresentationSubject({ flowId: 'f', steps, step: 1, nodesById, edgesById })).toBeNull();
    expect(resolvePresentationSubject({ flowId: 'f', steps, step: 9, nodesById, edgesById })).toBeNull();
    expect(presentableAttachments(undefined)).toEqual([]);
  });

  it('answers a presenter reveal with no flow playing, and puts the callout into words', () => {
    const attachments = [
      { id: 'd', type: 'note' as const, noteKind: 'decision' as const, text: ' Keep it. ' },
      { id: 'c', type: 'code' as const, code: '{}' },
    ];
    const nodes = [node('a', { attachments })];
    const reveal = { hostKind: 'node' as const, hostId: 'a', scope: 'present' };
    const subject = revealedSubject('present', reveal, new Map(nodes.map((n) => [n.id, n])), new Map());
    expect(subject?.key).toBe('present:node:a');
    expect(describePresentationSubject(subject!)).toBe('Decision: Keep it. Code attached.');
  });
});
