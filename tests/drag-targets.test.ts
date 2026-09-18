import { describe, expect, it } from 'vitest';
import { createDocument, createNode } from '../src/document/factory';
import { addNodes } from '../src/document/operations';
import { evaluateAttachCandidates } from '../src/canvas/dragTargets';

describe('evaluateAttachCandidates', () => {
  it('picks the topmost node under the drop point, not the first one in document order', () => {
    // A sits first in `doc.nodes` but B was brought in front of it (z only — bringToFront never
    // reorders the array), so B is what's actually rendered under the cursor.
    const a = createNode({ type: 'service', x: 0, y: 0, width: 200, height: 120, z: 0 });
    const b = createNode({ type: 'service', x: 40, y: 40, width: 200, height: 120, z: 1 });
    const doc = addNodes(createDocument('Drag'), [a, b]);

    const draggedRect = { x: 60, y: 60, width: 40, height: 40 };
    const { centerHitId } = evaluateAttachCandidates(draggedRect, 'note', doc, new Set());

    expect(centerHitId).toBe(b.id);
  });

  /**
   * A dragged Note/Code card is evaluated as a *point* — its aim point — rather than as its own
   * rectangle, because that rectangle is not on screen while its capsule stands in for it
   * (`Canvas.tsx`'s drag-to-attach wiring, `capsuleCollapse.ts`). Handing this the same zero-size
   * rect it is given there is what the whole interaction rests on, so the contract is pinned here
   * rather than left as an emergent property of the overlap arithmetic.
   */
  describe('given a zero-size rect at the aim point', () => {
    const point = (x: number, y: number) => ({ x, y, width: 0, height: 0 });

    it('never names an overlap winner, so every shape arms through the deliberate dwell', () => {
      const host = createNode({ type: 'service', x: 0, y: 0, width: 200, height: 120, z: 0 });
      const doc = addNodes(createDocument('Drag'), [host]);

      // Dead centre of the host — as committed a position as there is.
      const { overlapId, centerHitId } = evaluateAttachCandidates(point(100, 60), 'note', doc, new Set());

      expect(overlapId).toBeNull();
      expect(centerHitId).toBe(host.id);
    });

    it('names nothing at all just outside the host', () => {
      const host = createNode({ type: 'service', x: 0, y: 0, width: 200, height: 120, z: 0 });
      const doc = addNodes(createDocument('Drag'), [host]);

      const { overlapId, centerHitId } = evaluateAttachCandidates(point(201, 60), 'note', doc, new Set());

      expect(overlapId).toBeNull();
      expect(centerHitId).toBeNull();
    });

    it('still resolves overlapping hosts topmost-first', () => {
      const a = createNode({ type: 'service', x: 0, y: 0, width: 200, height: 120, z: 5 });
      const b = createNode({ type: 'service', x: 40, y: 40, width: 200, height: 120, z: 1 });
      const doc = addNodes(createDocument('Drag'), [a, b]);

      // Inside both; `a` is in front despite `b` coming later in the array.
      expect(evaluateAttachCandidates(point(60, 60), 'note', doc, new Set()).centerHitId).toBe(a.id);
    });

    it('skips the dragged card itself', () => {
      const host = createNode({ type: 'service', x: 0, y: 0, width: 200, height: 120, z: 0 });
      const note = createNode({ type: 'note', x: 50, y: 40, width: 120, height: 56, z: 1 });
      const doc = addNodes(createDocument('Drag'), [host, note]);

      const { centerHitId } = evaluateAttachCandidates(point(100, 60), 'note', doc, new Set([note.id]));

      expect(centerHitId).toBe(host.id);
    });
  });
});
