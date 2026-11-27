import { describe, expect, it } from 'vitest';
import { asDrawn } from '../../src/agent/quality';
import { createEdge, createNode } from '../../src/document/factory';
import type { DraftEdge, DraftNode } from '../../src/document/types';
import { chooseEdgeSides } from '../../src/edges/sides';

describe('a request is judged on connectors as the canvas draws them', () => {
  // Was: a repair re-anchors a connector in place, and the side plan of the connectors around it,
  // kept per connector object, went on reading its line from before. A request's last check could
  // pass, or refuse, a layout on lines the canvas never draws, since it draws a copy of the file.
  it('plans a neighbour around where a re-anchored connector now runs', () => {
    const at = (id: string, x: number, y: number) => ({ ...createNode({ type: 'service', x, y }), id, width: 160, height: 70 }) as DraftNode;
    const nodes = [at('n0', 260, 400), at('n1', 780, 400), at('n2', 260, 600), at('n3', 520, 200), at('n4', 0, 400)];
    const edge = (id: string, source: string, target: string) => ({ ...createEdge({ source, target }), id, routing: 'smoothstep' }) as DraftEdge;
    const edges = [edge('e0', 'n0', 'n3'), edge('e1', 'n2', 'n3'), edge('e2', 'n3', 'n4'), edge('e3', 'n0', 'n1'), edge('e4', 'n1', 'n2')];
    const mover = edges[0]!;
    mover.sourceAnchor = { side: 'bottom', offset: 0.5 };
    mover.targetAnchor = { side: 'top', offset: 0.5 };
    const none = () => undefined;
    const plan = (list: readonly DraftEdge[]) => JSON.stringify([...chooseEdgeSides(nodes, list, 'transient', none)].sort());
    plan(edges);
    // Re-anchored in place, as a repair does.
    mover.sourceAnchor = { side: 'right', offset: 0.5 };
    mover.targetAnchor = { side: 'right', offset: 0.5 };
    const drawn = plan(structuredClone(edges));
    expect(plan(asDrawn(edges))).toBe(drawn);
    // The repaired objects themselves still read the old line: what `asDrawn` is for. A memo that
    // compared a connector's own anchors would make these equal, and `asDrawn` unneeded.
    expect(plan([...edges])).not.toBe(drawn);
  });
});
