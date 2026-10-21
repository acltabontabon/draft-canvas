import { describe, expect, it } from 'vitest';
import { createDocument, createNode } from '../src/document/factory';
import { projectNodes } from '../src/canvas/projection';

/**
 * What sits in front of what on the canvas. React Flow lifts a selected node by 1,000
 * (`elevateNodesOnSelect`); a boundary must not rise with it, or selecting the outer of two
 * boundaries buries the inner one (and every connector inside) until the outer is let go.
 */

const SELECTED_LIFT = 1000;

function stacking(selected: string[]) {
  const doc = {
    ...createDocument('Stacking'),
    nodes: [
      createNode({ id: 'outer', type: 'group', x: 0, y: 0, width: 600, height: 400, z: 0 }),
      createNode({ id: 'inner', type: 'group', x: 40, y: 60, width: 300, height: 260, z: 1, parentId: 'outer' }),
      createNode({ id: 'svc', type: 'service', x: 80, y: 120, width: 160, height: 80, z: 2, parentId: 'inner' }),
    ],
  };
  const projected = projectNodes(doc, [], { selectedNodes: new Set(selected), selectedEdges: new Set(), interactive: true });
  // The z React Flow paints with: what we project, plus its own lift for a selected node.
  return Object.fromEntries(projected.map((node) => [node.id, node.zIndex! + (node.selected ? SELECTED_LIFT : 0)]));
}

describe('canvas stacking', () => {
  it('keeps a selected boundary below the boundaries nested in it', () => {
    const z = stacking(['outer']);
    expect(z.outer).toBeLessThan(z.inner!);
    expect(z.outer).toBeLessThan(z.svc!);
    expect(z).toEqual(stacking([]));
  });

  it('still lifts a selected shape over its neighbours', () => {
    expect(stacking(['svc']).svc).toBe(stacking([]).svc! + SELECTED_LIFT);
  });
});
