import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findEdgeDropCandidate } from '../src/canvas/edgeDropTarget';

/**
 * `elementsFromPoint` lists every element at a point, visible or not, so a connector running under a
 * panel is in the list as much as one in the open. jsdom has no layout and no `elementsFromPoint`, so
 * the stack is stood in for directly: what these check is which of its members count.
 */

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

function stackOf(...elements: Element[]) {
  Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: () => elements });
}

beforeEach(() => {
  // Ids here are plain, so escaping is the identity; jsdom does not always provide `CSS.escape`.
  vi.stubGlobal('CSS', { escape: (value: string) => value });
});

afterEach(() => {
  document.body.innerHTML = '';
  Reflect.deleteProperty(document, 'elementsFromPoint');
  vi.unstubAllGlobals();
});

const canvas = `
  <div class="react-flow">
    <div class="react-flow__edge" data-id="e1"><path id="hit" class="dc-edge-hit" d="M0 0 L100 0" /></div>
    <div class="react-flow__pane" id="pane"></div>
  </div>
  <aside class="dc-points"><span id="panel-text">Open points</span></aside>
  <div class="react-flow"><div class="dc-popover" id="popover"></div></div>
`;
const aim = { x: 50, y: 0 };

describe('the connector a dragged note would attach to', () => {
  it('is the one under the pointer in the open', () => {
    mount(canvas);
    stackOf(document.getElementById('hit')!);
    expect(findEdgeDropCandidate(50, 0, 'dragged', aim)).toBe('e1');
  });

  it('is not a connector hidden under a panel, even though it is in the stack', () => {
    mount(canvas);
    stackOf(document.getElementById('panel-text')!, document.getElementById('hit')!, document.getElementById('pane')!);
    expect(findEdgeDropCandidate(50, 0, 'dragged', aim)).toBeNull();
  });

  it("is not one hidden under a popover that sits in the canvas's own layer", () => {
    mount(canvas);
    stackOf(document.getElementById('popover')!, document.getElementById('hit')!);
    expect(findEdgeDropCandidate(50, 0, 'dragged', aim)).toBeNull();
  });

  it('still sees through the dragged shape itself, which is always on top of the point', () => {
    mount(`
      <div class="react-flow">
        <div class="react-flow__node" data-id="dragged"><span id="card">note</span></div>
        <div class="react-flow__edge" data-id="e1"><path id="hit" class="dc-edge-hit" d="M0 0 L100 0" /></div>
      </div>
    `);
    stackOf(document.getElementById('card')!, document.getElementById('hit')!);
    expect(findEdgeDropCandidate(50, 0, 'dragged', aim)).toBe('e1');
  });
});
