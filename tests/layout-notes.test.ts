import { describe, expect, it } from 'vitest';
import { createDocument, createNode } from '../src/document/factory';
import { addNodes, moveNodes } from '../src/document/operations';
import { fixesNote } from '../src/lib/arrangeFixes';
import { crossingsNote, layoutNotes, movesNote } from '../src/ui/Editor/arrangeSummary';

/** What the Arrange bar says beyond its name: what moved, what stopped early, what stays. */
describe('the Arrange bar', () => {
  it('says when it stopped early on a large diagram, and what to do about it', () => {
    expect(layoutNotes({ partial: true, scoped: false })).toEqual(['Stopped early on a large diagram. Apply it, then run Tidy connectors to finish the connectors.']);
    expect(layoutNotes({ partial: false, scoped: false })).toEqual([]);
  });

  it('says why only one direction is offered, rather than leaving the choice out', () => {
    expect(layoutNotes({ alternativeSkipped: true, scoped: false })).toEqual(['Only one direction was worked out for a diagram this size.']);
  });

  it('counts where connectors cross before and after, and says nothing when none do', () => {
    expect(crossingsNote({ direction: 'right', crossings: { before: 12, after: { right: 3, down: 5 } } })).toBe('Crossings 12 → 3');
    expect(crossingsNote({ direction: 'down', crossings: { before: 12, after: { right: 3, down: 5 } } })).toBe('Crossings 12 → 5');
    expect(crossingsNote({ direction: 'right', crossings: { before: 2, after: { right: 2 } } })).toBe('Crossings 2');
    expect(crossingsNote({ direction: 'right', crossings: { before: 0, after: { right: 0 } } })).toBe('');
    expect(crossingsNote({ direction: 'right' })).toBe('');
  });

  it('says that sketches stay where they are, and only when the room has some', () => {
    expect(layoutNotes({ sketches: 3, scoped: false })).toEqual(['3 sketches stay where they are.']);
    expect(layoutNotes({ sketches: 1, scoped: false })).toEqual(['1 sketch stays where it is.']);
    expect(layoutNotes({ sketches: 0, scoped: false })).toEqual([]);
    expect(layoutNotes({ scoped: false })).toEqual([]);
  });

  it('counts the shapes an arrangement moves', () => {
    const doc = addNodes(createDocument('Moves'), [
      createNode({ id: 'a', type: 'service', x: 0, y: 0 }),
      createNode({ id: 'b', type: 'service', x: 300, y: 0 }),
      createNode({ id: 'c', type: 'service', x: 600, y: 0 }),
    ]);
    expect(movesNote(doc, doc)).toBe('');
    expect(movesNote(doc, moveNodes(doc, new Map([['a', { x: 0, y: 50 }]])))).toBe('Moves 1 shape');
    expect(movesNote(doc, moveNodes(doc, new Map([['a', { x: 0, y: 50 }], ['c', { x: 600, y: 90 }]])))).toBe('Moves 2 shapes');
  });

  it('names a small overview as what it is', () => {
    expect(fixesNote([{ kind: 'sparse', id: '' }])).toBe('Fixes an overview too small to read');
  });
});
