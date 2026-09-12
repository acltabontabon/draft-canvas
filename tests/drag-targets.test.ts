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
});
