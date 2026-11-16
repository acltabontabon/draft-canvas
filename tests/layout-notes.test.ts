import { describe, expect, it } from 'vitest';
import { createDocument, createNode } from '../src/document/factory';
import { addNodes, moveNodes } from '../src/document/operations';
import { fixesNote } from '../src/lib/arrangeFixes';
import { layoutNotes, movesNote } from '../src/ui/Editor/arrangeSummary';

/** What the Arrange and Tidy up bars say beyond their name: what moved, what stopped early, what stays. */
describe('the bars of Arrange and Tidy up', () => {
  it('say when they stopped early on a large diagram, and what to do about it', () => {
    expect(layoutNotes({ partial: true, scoped: false }, 'tidy')).toEqual(['Stopped early on a large diagram. Apply it, then run Tidy up again to continue.']);
    expect(layoutNotes({ partial: true, scoped: false }, 'arrange')).toEqual(['Stopped early on a large diagram. Apply it, then run Tidy up to finish the connectors.']);
    expect(layoutNotes({ partial: false, scoped: false }, 'tidy')).toEqual([]);
  });

  it('say why only one direction is offered, rather than leaving the choice out', () => {
    expect(layoutNotes({ alternativeSkipped: true, scoped: false }, 'arrange')).toEqual(['Only one direction was worked out for a diagram this size.']);
    // Tidy up has no direction to speak of.
    expect(layoutNotes({ alternativeSkipped: true, scoped: false }, 'tidy')).toEqual([]);
  });

  it('say that sketches stay where they are, and only when the room has some', () => {
    expect(layoutNotes({ sketches: 3, scoped: false }, 'arrange')).toEqual(['3 sketches stay where they are.']);
    expect(layoutNotes({ sketches: 1, scoped: false }, 'tidy')).toEqual(['1 sketch stays where it is.']);
    expect(layoutNotes({ sketches: 0, scoped: false }, 'arrange')).toEqual([]);
    expect(layoutNotes({ scoped: false }, 'arrange')).toEqual([]);
  });

  it('count the shapes an arrangement moves', () => {
    const doc = addNodes(createDocument('Moves'), [
      createNode({ id: 'a', type: 'service', x: 0, y: 0 }),
      createNode({ id: 'b', type: 'service', x: 300, y: 0 }),
      createNode({ id: 'c', type: 'service', x: 600, y: 0 }),
    ]);
    expect(movesNote(doc, doc)).toBe('');
    expect(movesNote(doc, moveNodes(doc, new Map([['a', { x: 0, y: 50 }]])))).toBe('Moves 1 shape');
    expect(movesNote(doc, moveNodes(doc, new Map([['a', { x: 0, y: 50 }], ['c', { x: 600, y: 90 }]])))).toBe('Moves 2 shapes');
  });

  it('name a small overview as what it is', () => {
    expect(fixesNote([{ kind: 'sparse', id: '' }])).toBe('Fixes an overview too small to read');
  });
});
