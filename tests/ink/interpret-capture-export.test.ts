import { describe, expect, it } from 'vitest';
import { applyChanges } from '../../src/collab/apply';
import { diffFile } from '../../src/collab/diff';
import { sanitizeChanges } from '../../src/collab/sanitize';
import { addInk, inkOf, removeInk, translateInk } from '../../src/document/ink';
import { createDocument, createNode } from '../../src/document/factory';
import { LIMITS } from '../../src/document/limits';
import type { DraftDocument, DraftInk } from '../../src/document/types';
import { buildStroke } from '../../src/ink/capture';
import { boxForChoice } from '../../src/ink/choices';
import { interpret, type InkContextNode } from '../../src/ink/interpret';
import { recognize } from '../../src/ink/recognize';
import { inkPaint } from '../../src/render/ink';
import { renderDocumentSvg } from '../../src/render/svg/document';
import { pushEntry, EMPTY_HISTORY, type HistoryEntry } from '../../src/history/HistoryStack';
import * as c from './corpus';

const service = (id: string, x: number, y: number): InkContextNode => ({ id, type: 'service', x, y, width: 176, height: 68 });
const group = (id: string, x: number, y: number, width: number, height: number): InkContextNode => ({ id, type: 'group', x, y, width, height });
const read = (strokes: { x: number; y: number }[][], nodes: InkContextNode[], forced = false) => interpret(recognize(strokes, { scale: 1 }), nodes, { scale: 1, forced });

describe('what a drawing means here', () => {
  it('offers a box in empty space as a Component first, never as anything more specific', () => {
    const result = read(c.rectangle(0, 300, 180, 90, c.hand(1)), [service('a', 0, 0)]);
    expect(result).toMatchObject({ kind: 'shape', confident: true, choices: ['component', 'service', 'boundary', 'note'] });
  });

  it('offers a large empty box as a Boundary first', () => {
    const result = read(c.rectangle(0, 300, 420, 260, c.hand(2)), []);
    expect(result.kind === 'shape' && result.choices[0]).toBe('boundary');
  });

  it('offers a box round shapes only as their Boundary, naming what it holds', () => {
    const result = read(c.rectangle(-20, -20, 600, 120, c.hand(3)), [service('a', 0, 0), service('b', 300, 0)]);
    expect(result).toMatchObject({ kind: 'shape', choices: ['boundary'], encloses: ['a', 'b'] });
  });

  it('a box drawn inside a Boundary is a part of it', () => {
    const result = read(c.rectangle(40, 40, 180, 80, c.hand(4)), [group('g', 0, 0, 500, 300)]);
    expect(result.kind === 'shape' && result.choices[0]).toBe('component');
  });

  it('leaves marks on or across shapes as ink: a box half over one, a circle round one', () => {
    expect(read(c.rectangle(100, -20, 200, 100, c.hand(5)), [service('a', 0, 0)])).toMatchObject({ kind: 'none', reason: 'annotation' });
    expect(read(c.ellipse(88, 34, 130, 70, c.hand(6)), [service('a', 0, 0)])).toMatchObject({ kind: 'none' });
  });

  it('reads a cylinder as a Data Store, a tube as a Queue, a stick figure as an Actor', () => {
    const store = read(c.cylinder(0, 300, 110, 140, c.hand(7)), []);
    expect(store.kind === 'shape' && store.choices[0]).toBe('database');
    const queue = read(c.tube(0, 300, 220, 64, c.hand(8)), []);
    expect(queue.kind === 'shape' && queue.choices[0]).toBe('queue');
    const actor = read(c.stickFigure(100, 300, 150, c.hand(9)), []);
    expect(actor.kind === 'shape' && actor.choices[0]).toBe('actor');
  });

  it('a small circle is a Junction first; a large one is not', () => {
    const small = read(c.ellipse(100, 300, 18, 18, c.hand(10, 0.6, 0.2)), []);
    expect(small.kind === 'shape' && small.choices[0]).toBe('junction');
    const large = read(c.ellipse(100, 300, 90, 60, c.hand(11)), []);
    expect(large.kind === 'shape' && large.choices[0]).toBe('component');
  });

  it('connects two shapes with a line between them, directed only when it has a head', () => {
    const nodes = [service('a', 0, 0), service('b', 400, 0)];
    expect(read(c.line({ x: 170, y: 34 }, { x: 405, y: 36 }, c.hand(12)), nodes)).toMatchObject({ kind: 'connector', source: 'a', target: 'b', directed: false });
    expect(read(c.arrowSeparateHead({ x: 405, y: 36 }, { x: 170, y: 34 }, c.hand(13)), nodes)).toMatchObject({ kind: 'connector', source: 'b', target: 'a', directed: true });
  });

  it('never invents a connection: a line into empty space, or under one shape, stays ink', () => {
    const nodes = [service('a', 0, 0), service('b', 400, 0)];
    expect(read(c.arrowOneStroke({ x: 170, y: 34 }, { x: 300, y: 200 }, c.hand(14)), nodes)).toMatchObject({ kind: 'none', reason: 'unanchored' });
    expect(read(c.line({ x: 10, y: 60 }, { x: 160, y: 62 }, c.hand(15)), nodes)).toMatchObject({ kind: 'none' });
  });

  it('a line ending inside a Boundary but on no shape is not a connector to the Boundary', () => {
    const nodes = [service('a', 0, 0), group('g', 300, -100, 600, 400)];
    expect(read(c.line({ x: 170, y: 34 }, { x: 600, y: 60 }, c.hand(16)), nodes)).toMatchObject({ kind: 'none', reason: 'unanchored' });
  });

  it('gives a chosen element at least its own minimum size, around the drawn centre', () => {
    expect(boxForChoice('component', { x: 0, y: 0, width: 60, height: 30 }, { width: 152, height: 56 })).toEqual({ x: -26, y: -9, width: 112, height: 48 });
    expect(boxForChoice('junction', { x: 0, y: 0, width: 50, height: 50 }, { width: 36, height: 36 })).toEqual({ x: 7, y: 7, width: 36, height: 36 });
  });
});

describe('capturing a stroke', () => {
  it('thins dense samples without changing the drawing, and stores it compactly', () => {
    const samples = Array.from({ length: 400 }, (_, i) => ({ x: 100 + i * 0.5, y: 50 + Math.sin(i / 40) * 20, pressure: 0.5 }));
    const stroke = buildStroke(samples, { tool: 'pen', color: 'blue', size: 3 }, { zoom: 1, pressure: false })!;
    expect(stroke.points.length / 2).toBeLessThan(80);
    expect(stroke).toMatchObject({ x: 100, y: 50, tool: 'pen', color: 'blue' });
    expect(stroke.pressure).toBeUndefined();
    expect(stroke.points.every((value) => Math.round(value * 10) === value * 10)).toBe(true);
  });

  it('keeps real stylus pressure, aligned with the points it kept; ignores a flat value', () => {
    const samples = Array.from({ length: 60 }, (_, i) => ({ x: i * 4, y: (i % 2) * 3, pressure: 0.2 + i / 100 }));
    const pressed = buildStroke(samples, { tool: 'pen', color: 'graphite', size: 3 }, { zoom: 1, pressure: true })!;
    expect(pressed.pressure).toHaveLength(pressed.points.length / 2);
    const flat = buildStroke(samples.map((s) => ({ ...s, pressure: 0.5 })), { tool: 'pen', color: 'graphite', size: 3 }, { zoom: 1, pressure: true })!;
    expect(flat.pressure).toBeUndefined();
  });

  it('caps a stroke at the point limit', () => {
    const samples = Array.from({ length: LIMITS.maxInkPoints * 4 }, (_, i) => ({ x: i, y: Math.sin(i) * 30, pressure: 0.5 }));
    const stroke = buildStroke(samples, { tool: 'pen', color: 'red', size: 3 }, { zoom: 1, pressure: false })!;
    expect(stroke.points.length / 2).toBeLessThanOrEqual(LIMITS.maxInkPoints);
  });

  it('a tap is a dot', () => {
    const dot = buildStroke([{ x: 5, y: 5, pressure: 0.5 }], { tool: 'pen', color: 'red', size: 3 }, { zoom: 1, pressure: false })!;
    expect(dot.points).toEqual([0, 0]);
    expect(inkPaint(dot, 'dark').d).toMatch(/^M0 0l0 0\.01$/);
  });
});

const stroke = (id: string, extra: Partial<DraftInk> = {}): DraftInk => ({ id, tool: 'pen', color: 'red', size: 3, x: 10, y: 20, points: [0, 0, 40, 10, 80, 0], ...extra });

describe('exporting sketches', () => {
  const doc = (): DraftDocument => addInk({ ...createDocument(), nodes: [createNode({ id: 'n_a', type: 'service', x: 0, y: 0 })] }, [stroke('k1', { x: 400, y: 300 }), stroke('k2', { tool: 'highlighter', color: 'yellow', size: 20 })]);

  it('draws every stroke into the picture, and frames the picture round them', () => {
    const plain = renderDocumentSvg({ ...createDocument(), nodes: doc().nodes });
    const drawn = renderDocumentSvg(doc());
    expect((drawn.svg.match(/<path[^>]*stroke="#ff6b6b"/g) ?? []).length).toBe(1);
    expect(drawn.svg).toContain('opacity="0.32"');
    expect(drawn.width).toBeGreaterThan(plain.width);
    expect(drawn.height).toBeGreaterThan(plain.height);
  });

  it('draws them in the light theme’s inks for a light export, and leaves them out on request', () => {
    expect(renderDocumentSvg(doc(), { theme: 'light' }).svg).toContain('stroke="#e03131"');
    expect(renderDocumentSvg(doc(), { ink: false }).svg).not.toContain('#ff6b6b');
    expect(renderDocumentSvg(doc(), { only: new Set(['n_a']) }).svg).not.toContain('#ff6b6b');
  });

  it('draws a pressure stroke as a filled outline', () => {
    const paint = inkPaint(stroke('k', { pressure: [10, 80, 30] }), 'dark');
    expect(paint.mode).toBe('fill');
    expect(paint.d).toMatch(/Z$/);
  });
});

describe('sketches between collaborators', () => {
  const base = (): DraftDocument => ({ ...createDocument(), nodes: [createNode({ id: 'n_a', type: 'service', x: 0, y: 0 })] });

  it('travels stroke by stroke: drawn, moved, restacked, erased', () => {
    const empty = base();
    const a = addInk(empty, [stroke('k1'), stroke('k2')]);
    const steps: DraftDocument[] = [a, translateInk(a, ['k1'], 5, 5), { ...a, ink: [...inkOf(a)].reverse() }, removeInk(a, ['k2']), removeInk(a, ['k1', 'k2'])];
    for (const next of steps) {
      const changes = diffFile(empty, next);
      expect(applyChanges(empty, changes)).toEqual(next);
      const again = diffFile(a, next);
      expect(applyChanges(a, again)).toEqual(next);
    }
    // A move is two numbers, not the stroke's every point redrawn into another stroke.
    const moved = diffFile(a, translateInk(a, ['k1'], 5, 5));
    expect(moved).toEqual([{ kind: 'ink', id: 'k1', room: '', value: { ...stroke('k1'), x: 15, y: 25 } }]);
  });

  it('checks a collaborator’s stroke the way a file’s is checked', () => {
    expect(sanitizeChanges([{ kind: 'ink', id: 'k1', room: '', value: stroke('k1', { size: 1e9 }) }])).toMatchObject({ ok: true, changes: [{ value: { size: LIMITS.maxInkSize } }] });
    expect(sanitizeChanges([{ kind: 'ink', id: 'k1', room: '', value: { id: 'k1', tool: 'laser' } }]).ok).toBe(false);
    expect(sanitizeChanges([{ kind: 'ink', id: 'k1', room: '', value: null }]).ok).toBe(true);
    expect(sanitizeChanges([{ kind: 'order', room: '', collection: 'ink', ids: ['k1'] }]).ok).toBe(true);
  });
});

describe('history', () => {
  const entry = (at: number, amendKey?: string, label = 'x'): HistoryEntry => ({
    label,
    before: createDocument(),
    after: createDocument(),
    path: [],
    selectionBefore: { nodes: [], edges: [] },
    selectionAfter: { nodes: [], edges: [] },
    at,
    amendKey,
  });

  it('an amending entry replaces the one it revises however much later it comes', () => {
    const first = pushEntry(EMPTY_HISTORY, { ...entry(0, 'ink:n1', 'Draw Component'), after: addInk(createDocument(), [stroke('k')]) });
    const revised = pushEntry(first, { ...entry(60_000, 'ink:n1', 'Draw Service'), after: addInk(createDocument(), [stroke('j')]) });
    expect(revised.past).toHaveLength(1);
    expect(revised.past[0]!.label).toBe('Draw Component');
    const other = pushEntry(revised, entry(60_100, 'ink:n2'));
    expect(other.past).toHaveLength(2);
  });
});
