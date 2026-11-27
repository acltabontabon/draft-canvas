import { describe, expect, it } from 'vitest';
import { compose } from '../../src/agent/compile';
import { applyUpdate } from '../../src/agent/patch';
import type { DraftDocument, DraftEdge } from '../../src/document/types';
import { handleAnchorsOf, handleIdForAnchor } from '../../src/edges/routing';
import { deserializeDocument } from '../../src/export/project';

/**
 * A Junction has only the middle of each side to connect to (`DraftNodeView` renders four handles).
 * Agent layouts used to spread two lines arriving at one side of a Junction over 0.25 and 0.75 of it,
 * a "left@2" React Flow could not find (error 008): the connector was not drawn at all.
 */
function build(raw: Record<string, unknown>): DraftDocument {
  const parsed = deserializeDocument(compose({ title: 'Store', ...raw }, 'd_junctionanchors').text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.document;
}

const service = (id: string, label: string) => ({ id, type: 'service', label });

/** Two services meeting at one junction, with lines of their own beside it. */
const meeting = () =>
  build({
    nodes: [service('cart', 'Cart Service'), service('search', 'Search Service'), { id: 'hub', type: 'junction', label: 'A', link: 'handoff' }, service('orders', 'Order Service'), service('stock', 'Stock Service')],
    relationships: [
      { id: 'r1', from: 'cart', to: 'hub' },
      { id: 'r2', from: 'search', to: 'hub' },
      { id: 'r3', from: 'hub', to: 'orders', label: 'places' },
      { id: 'r4', from: 'hub', to: 'stock', label: 'reserves' },
      { id: 'r5', from: 'cart', to: 'orders' },
      { id: 'r6', from: 'search', to: 'stock' },
    ],
  });

/** Every end of a connector at a Junction names a handle the Junction renders, or none. */
function junctionHandles(file: DraftDocument): string[] {
  const junctions = new Set(file.nodes.filter((node) => node.type === 'ellipse').map((node) => node.id));
  const real = new Set(handleAnchorsOf('ellipse').map((anchor) => anchor.id));
  const ends = (edge: DraftEdge) => [
    junctions.has(edge.source) ? edge.sourceAnchor : undefined,
    junctions.has(edge.target) ? edge.targetAnchor : undefined,
  ];
  const named = file.edges.flatMap(ends).filter((anchor) => anchor !== undefined).map((anchor) => `${anchor.side}@${anchor.offset}`);
  // Stored as given, not passed through the handle lookup's own snapping, so a wrong pin shows.
  return named.filter((id) => !real.has(id.replace('@0.5', '@1')));
}

describe('connector ends at a Junction', () => {
  it('a composed diagram pins them only at the middle of a side', () => {
    const file = meeting();
    expect(file.edges.some((edge) => edge.targetAnchor && edge.target === 'hub')).toBe(true);
    expect(junctionHandles(file)).toEqual([]);
  });

  it('a hand route lands on the middle of the side asked for', () => {
    const { file } = applyUpdate(meeting(), [], [{ op: 'update', id: 'r1', set: { route: { from: 'right', to: { side: 'left', offset: 0.75 } } } }], undefined);
    expect(file.edges.find((edge) => edge.id === 'r1')!.targetAnchor).toEqual({ side: 'left', offset: 0.5 });
    expect(junctionHandles(file)).toEqual([]);
  });

  it('a stored end off the middle is read onto it, and other shapes keep theirs', () => {
    const file = meeting();
    const raw = JSON.parse(JSON.stringify(file)) as DraftDocument;
    const edge = raw.edges.find((e) => e.id === 'r1')!;
    edge.sourceAnchor = { side: 'right', offset: 0.75 };
    edge.targetAnchor = { side: 'left', offset: 0.75 };
    const parsed = deserializeDocument(JSON.stringify(raw));
    if (!parsed.ok) throw new Error(parsed.error);
    const read = parsed.document.edges.find((e) => e.id === 'r1')!;
    expect(read.sourceAnchor).toEqual({ side: 'right', offset: 0.75 });
    expect(read.targetAnchor).toEqual({ side: 'left', offset: 0.5 });
  });

  it('never names a handle the shape does not render', () => {
    expect(handleIdForAnchor({ side: 'left', offset: 0.75 }, 'ellipse')).toBe('left@1');
    expect(handleIdForAnchor({ side: 'left', offset: 0.75 }, 'service')).toBe('left@2');
    expect(handleAnchorsOf('ellipse').map((anchor) => anchor.id).sort()).toEqual(['bottom@1', 'left@1', 'right@1', 'top@1']);
  });
});
