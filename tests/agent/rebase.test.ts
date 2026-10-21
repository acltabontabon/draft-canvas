import { describe, expect, it } from 'vitest';
import { overlapOf } from '../../src/agent/rebase';
import { createDocument, createNode } from '../../src/document/factory';
import type { DraftDocument } from '../../src/document/types';

function base(): DraftDocument {
  const owner = createNode({ type: 'service', x: 0, y: 0, id: 'api' });
  owner.inside = { nodes: [createNode({ type: 'service', x: 0, y: 0, id: 'inner' })], edges: [], flows: [], viewport: { x: 0, y: 0, zoom: 1 } };
  return { ...createDocument('Orders'), nodes: [owner, createNode({ type: 'database', x: 300, y: 0, id: 'db' })] };
}

const withInsideLevel = (file: DraftDocument, level: 'container' | 'component'): DraftDocument => ({
  ...file,
  nodes: file.nodes.map((node) => (node.id === 'api' && node.inside ? { ...node, inside: { ...node.inside, level } } : node)),
});

describe('rebase conflict detection', () => {
  it('sees both sides retitling the diagram', () => {
    const file = base();
    const theirs = { ...file, metadata: { ...file.metadata, title: 'Checkout' } };
    const ours = { ...file, metadata: { ...file.metadata, title: 'Payments' } };
    expect(overlapOf(file, theirs, ours)).not.toHaveLength(0);
  });

  it('sees both sides changing a room’s level', () => {
    const file = base();
    expect(overlapOf(file, withInsideLevel(file, 'container'), withInsideLevel(file, 'component'))).not.toHaveLength(0);
  });

  it('sees both sides changing the same open point', () => {
    const point = { id: 'op1', kind: 'awaiting' as const, targets: [{ kind: 'node' as const, id: 'db' }] };
    const file = { ...base(), openPoints: [point] };
    const theirs = { ...file, openPoints: [{ ...point, context: 'Which engine?' }] };
    const ours = { ...file, openPoints: [{ ...point, resolved: true as const }] };
    expect(overlapOf(file, theirs, ours)).toEqual(['op1']);
  });

  it('lets independent edits through', () => {
    const file = base();
    const theirs = { ...file, metadata: { ...file.metadata, title: 'Checkout' } };
    const ours = withInsideLevel(file, 'container');
    expect(overlapOf(file, theirs, ours)).toEqual([]);
  });
});
