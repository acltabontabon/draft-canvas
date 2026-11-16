import { describe, expect, it } from 'vitest';
import { embed, viewOf } from '../../src/depth/tree';
import { addInk, inkBounds, inkOf, removeInk, translateInk, withInk } from '../../src/document/ink';
import { createDocument, createNode } from '../../src/document/factory';
import { LIMITS } from '../../src/document/limits';
import { pasteFragment } from '../../src/document/operations';
import { CURRENT_VERSION, type DraftDocument, type DraftInk } from '../../src/document/types';
import { parseDocument } from '../../src/document/validate';
import { serializeDocument } from '../../src/export/project';

const stroke = (id: string, extra: Partial<DraftInk> = {}): DraftInk => ({ id, tool: 'pen', color: 'red', size: 3, x: 10, y: 20, points: [0, 0, 12.5, 4, 30, 9.1], ...extra });

describe('ink in the document model', () => {
  it('is absent, never empty, when there is none', () => {
    const doc = createDocument();
    expect('ink' in doc).toBe(false);
    const drawn = addInk(doc, [stroke('k1')]);
    expect(inkOf(drawn)).toHaveLength(1);
    const erased = removeInk(drawn, ['k1']);
    expect('ink' in erased).toBe(false);
    expect(withInk(doc, [])).toBe(doc);
  });

  it('hands back the same document for edits that change nothing', () => {
    const doc = addInk(createDocument(), [stroke('k1')]);
    expect(addInk(doc, [stroke('k1')])).toBe(doc);
    expect(removeInk(doc, ['missing'])).toBe(doc);
    expect(translateInk(doc, ['k1'], 0, 0)).toBe(doc);
  });

  it('moves a stroke by its origin alone, sharing its points', () => {
    const doc = addInk(createDocument(), [stroke('k1')]);
    const moved = translateInk(doc, ['k1'], 15, -5);
    const [before] = inkOf(doc);
    const [after] = inkOf(moved);
    expect(after).toMatchObject({ x: 25, y: 15 });
    expect(after!.points).toBe(before!.points);
    expect(inkBounds(after!)).toEqual({ x: 25, y: 15, width: 30, height: 9.1 });
  });
});

describe('reading ink from a file', () => {
  const file = (ink: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ ...createDocument(), ink, ...extra });

  it('round-trips through a saved file', () => {
    const doc = addInk({ ...createDocument(), nodes: [createNode({ type: 'service', x: 0, y: 0 })] }, [stroke('k1', { pressure: [10, 50, 90] }), stroke('k2', { tool: 'highlighter', color: 'yellow', size: 20 })]);
    const parsed = parseDocument(serializeDocument(doc));
    expect(parsed.ok && parsed.repairs).toEqual([]);
    expect(parsed.ok && parsed.document.ink).toEqual(doc.ink);
  });

  it('opens a file from before sketches existed, and says it upgraded it', () => {
    const old = { ...createDocument(), version: 27 };
    const parsed = parseDocument(JSON.stringify(old));
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.document.version).toBe(CURRENT_VERSION);
    expect(parsed.ok && 'ink' in parsed.document).toBe(false);
  });

  it('refuses a file from a newer build by name rather than dropping its sketches', () => {
    const parsed = parseDocument(JSON.stringify({ ...createDocument(), version: CURRENT_VERSION + 1, ink: [stroke('k1')] }));
    expect(parsed.ok).toBe(false);
  });

  it('repairs what it can and drops only strokes it cannot read', () => {
    const parsed = parseDocument(
      file([
        stroke('k1', { size: 9999 }),
        stroke('k2', { pressure: [1, 2] }),
        { id: 'k3', tool: 'brush', x: 0, y: 0, points: [0, 0] },
        { id: 'k4', tool: 'pen', x: 'a', y: 0, points: [0, 0] },
        { id: 'k5', tool: 'pen', x: 0, y: 0, points: [0, 'x'] },
        { id: 'k6', tool: 'pen', x: 0, y: 0, points: [] },
        stroke('k1'),
        'nonsense',
      ]),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const ink = parsed.document.ink!;
    expect(ink).toHaveLength(3);
    expect(ink[0]!.size).toBe(LIMITS.maxInkSize);
    // A pressure list that doesn't match its points is dropped; the line draws evenly instead.
    expect(ink[1]!.pressure).toBeUndefined();
    // The duplicate id is given a new one rather than dropped.
    expect(ink[2]!.id).not.toBe('k1');
    expect(parsed.repairs.some((line) => /Dropped 5 unreadable sketch stroke/.test(line))).toBe(true);
  });

  it('keeps an over-long stroke to its first points and the file to its stroke allowance', () => {
    const long = stroke('k1', { points: Array.from({ length: (LIMITS.maxInkPoints + 50) * 2 }, (_, i) => i % 7) });
    const many = Array.from({ length: LIMITS.maxInkStrokes + 3 }, (_, i) => stroke(`k${i + 2}`));
    const parsed = parseDocument(file([long, ...many]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.ink![0]!.points).toHaveLength(LIMITS.maxInkPoints * 2);
    expect(parsed.document.ink).toHaveLength(LIMITS.maxInkStrokes);
    expect(parsed.repairs.some((line) => line.includes('more sketch strokes'))).toBe(true);
  });

  it('keeps each room’s sketches in that room, and ids unique across the file', () => {
    const owner = createNode({ type: 'service', x: 0, y: 0 });
    const inner = createNode({ type: 'component', x: 0, y: 0 });
    const raw = {
      ...createDocument(),
      ink: [stroke('k1')],
      nodes: [{ ...owner, inside: { nodes: [inner], edges: [], flows: [], viewport: { x: 0, y: 0, zoom: 1 }, ink: [stroke('k1'), stroke('k2')] } }],
    };
    const parsed = parseDocument(JSON.stringify(raw));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const room = parsed.document.nodes[0]!.inside!;
    expect(parsed.document.ink!.map((s) => s.id)).toEqual(['k1']);
    expect(room.ink).toHaveLength(2);
    expect(room.ink![0]!.id).not.toBe('k1');
  });
});

describe('ink and rooms', () => {
  const file = (): DraftDocument => {
    const owner = createNode({ id: 'n_owner', type: 'service', x: 0, y: 0 });
    const inner = createNode({ id: 'n_inner', type: 'component', x: 0, y: 0 });
    return addInk({ ...createDocument(), nodes: [{ ...owner, inside: { nodes: [inner], edges: [], flows: [], viewport: { x: 0, y: 0, zoom: 1 } } }] }, [stroke('k_root')]);
  };

  it('never shows the file’s sketches inside a room', () => {
    const view = viewOf(file(), ['n_owner'])!;
    expect(inkOf(view)).toEqual([]);
  });

  it('writes a room’s sketches back into that room only', () => {
    const outer = file();
    const view = viewOf(outer, ['n_owner'])!;
    const drawn = addInk(view, [stroke('k_room')]);
    const next = embed(outer, ['n_owner'], drawn);
    expect(inkOf(next).map((s) => s.id)).toEqual(['k_root']);
    expect(next.nodes[0]!.inside!.ink!.map((s) => s.id)).toEqual(['k_room']);
    expect(inkOf(viewOf(next, ['n_owner'])!).map((s) => s.id)).toEqual(['k_room']);
    // Erased again, the room's field goes and the room stays (it still holds a shape).
    const erased = embed(next, ['n_owner'], removeInk(viewOf(next, ['n_owner'])!, ['k_room']));
    expect('ink' in erased.nodes[0]!.inside!).toBe(false);
  });

  it('carries a room’s sketches along with a copied shape, under new ids', () => {
    const outer = addInk(file(), []);
    const roomed = embed(outer, ['n_owner'], addInk(viewOf(outer, ['n_owner'])!, [stroke('k_room')]));
    const owner = roomed.nodes[0]!;
    const pasted = pasteFragment(createDocument(), { nodes: [owner], edges: [] }, { x: 40, y: 40 }, { nodes: 0, edges: 0 });
    const copy = pasted.doc.nodes[0]!;
    expect(copy.inside!.ink).toHaveLength(1);
    expect(copy.inside!.ink![0]!.id).not.toBe('k_room');
  });
});
