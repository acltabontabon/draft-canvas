import { afterEach, describe, expect, it, vi } from 'vitest';
import { pickEdgeAt } from '../src/canvas/edgePick';

/**
 * jsdom has no layout, so the browser's answers are stood in for: `elementFromPoint` is the topmost
 * element at the point and `elementsFromPoint` the whole stack, top first. What these check is what
 * the picker makes of them — and that it doesn't ask for the whole stack when the top settles it,
 * which on a large diagram is 20 ms of stroke-testing every connector's hit path, per click.
 */

function stackOf(...elements: Element[]) {
  const all = vi.fn(() => elements);
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => elements[0] ?? null });
  Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: all });
  return all;
}

afterEach(() => {
  document.body.innerHTML = '';
  Reflect.deleteProperty(document, 'elementFromPoint');
  Reflect.deleteProperty(document, 'elementsFromPoint');
});

const byId = (id: string) => document.getElementById(id)!;

const canvas = `
  <div class="react-flow">
    <div class="react-flow__node" data-id="n1">
      <div class="dc-node" data-type="service"><span id="title">Orders</span></div>
      <div class="react-flow__handle" id="ring"></div>
    </div>
    <svg><g class="react-flow__edge" data-id="e1"><path id="hit" class="dc-edge-hit" d="M0 0 L100 0" /></g></svg>
    <div class="react-flow__pane" id="pane"></div>
  </div>
`;
const aim = { x: 50, y: 0 };

describe('the connector at a point', () => {
  it("is none on a shape's own body, known from the top element alone", () => {
    document.body.innerHTML = canvas;
    const all = stackOf(byId('title'), byId('hit'), byId('pane'));
    expect(pickEdgeAt(50, 0, aim, 1)).toBeNull();
    expect(all).not.toHaveBeenCalled();
  });

  it('is the one whose hit path is under the pointer', () => {
    document.body.innerHTML = canvas;
    stackOf(byId('hit'), byId('pane'));
    expect(pickEdgeAt(50, 0, aim, 1)).toEqual({ id: 'e1', part: 'line', tied: ['e1'] });
  });

  it("is looked for through a handle's ring where it reaches past its shape", () => {
    document.body.innerHTML = canvas;
    // jsdom's boxes are all empty, so the point is outside the node's body: the ring is see-through.
    stackOf(byId('ring'), byId('hit'), byId('pane'));
    expect(pickEdgeAt(50, 0, aim, 1)?.id).toBe('e1');
  });

  it('is none on empty canvas', () => {
    document.body.innerHTML = canvas;
    stackOf(byId('pane'));
    expect(pickEdgeAt(50, 0, aim, 1)).toBeNull();
  });
});
