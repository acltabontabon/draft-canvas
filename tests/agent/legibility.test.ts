import { describe, expect, it } from 'vitest';
import { adviceFor } from '../../src/agent/advice';
import { compose } from '../../src/agent/compile';
import { readCreate } from '../../src/agent/input';
import { isDetour, legibilityOf, type Legibility } from '../../src/agent/legibility';
import { deserializeDocument } from '../../src/export/project';
import { createNode } from '../../src/document/factory';
import type { DraftEdge, DraftNode } from '../../src/document/types';

const node = (id: string, x: number, y: number, extra: Partial<DraftNode> = {}): DraftNode => ({ ...createNode({ id, type: 'service', x, y }), width: 100, height: 60, ...extra });
const edge = (id: string, source: string, target: string, sourceSide: 'left' | 'right' | 'top' | 'bottom', targetSide: 'left' | 'right' | 'top' | 'bottom'): DraftEdge =>
  ({ id, source, target, routing: 'smoothstep', sourceAnchor: { side: sourceSide, offset: 0.5 }, targetAnchor: { side: targetSide, offset: 0.5 } }) as DraftEdge;

const clean: Legibility = { crossings: 0, detours: [], throughBoundaries: [], farNotes: [], bundled: 0, length: 0, fill: 1 };

describe('legibility', () => {
  it('counts two connectors crossing, and none for connectors that only share an end', () => {
    // a → d runs right along the top; b → c runs up through it.
    const nodes = [node('a', 0, 0), node('d', 600, 0), node('b', 300, 300), node('c', 300, -300)];
    const crossing = legibilityOf(nodes, [edge('ad', 'a', 'd', 'right', 'left'), edge('bc', 'b', 'c', 'top', 'bottom')]);
    expect(crossing.crossings).toBe(1);
    const fan = legibilityOf(nodes, [edge('ad', 'a', 'd', 'right', 'left'), edge('ab', 'a', 'b', 'right', 'left')]);
    expect(fan.crossings).toBe(0);
  });

  it('flags a connector through a boundary neither end is in, but not one leaving its own', () => {
    const group = { ...createNode({ id: 'g', type: 'group', x: 250, y: -100 }), width: 200, height: 260 } as DraftNode;
    const nodes = [group, node('a', 0, 0), node('d', 600, 0), node('in', 300, 50, { parentId: 'g' })];
    const through = legibilityOf(nodes, [edge('ad', 'a', 'd', 'right', 'left')]);
    expect(through.throughBoundaries).toEqual(['ad']);
    const out = legibilityOf(nodes, [edge('ind', 'in', 'd', 'right', 'left')]);
    expect(out.throughBoundaries).toEqual([]);
  });

  it('flags a note far from what it is about, and a connector that goes the long way round', () => {
    const note = { ...createNode({ id: 'n', type: 'note', x: 900, y: 900 }), width: 100, height: 40 } as DraftNode;
    const nodes = [node('a', 0, 0), node('b', 300, 0), note];
    const far = legibilityOf(nodes, [], new Map([['n', 'a']]));
    expect(far.farNotes).toEqual(['n']);
    // Two neighbours 200 apart: straight across is fine, round the outside of the diagram is not.
    const a = { x: 0, y: 0, width: 100, height: 60 };
    const b = { x: 300, y: 0, width: 100, height: 60 };
    expect(isDetour([{ x: 100, y: 30 }, { x: 300, y: 30 }], a, b)).toBe(false);
    expect(isDetour([{ x: 50, y: 60 }, { x: 50, y: 80 }, { x: 350, y: 80 }, { x: 350, y: 60 }], a, b)).toBe(false);
    expect(isDetour([{ x: 50, y: 60 }, { x: 50, y: 400 }, { x: 350, y: 400 }, { x: 350, y: 60 }], a, b)).toBe(true);
  });

  it('keeps the requested reading direction unless the other is clearly better, and reports legibility', () => {
    const out = compose(
      {
        requestId: 'r',
        title: 'Chain',
        nodes: ['a', 'b', 'c'].map((id) => ({ id, type: 'service', label: id })),
        relationships: [
          { id: 'ab', from: 'a', to: 'b' },
          { id: 'bc', from: 'b', to: 'c' },
        ],
      },
      'd_legibility01',
    );
    expect(out.receipt).toMatchObject({ layout: { direction: 'right' }, legibility: { crossings: 0 } });
    const parsed = deserializeDocument(out.text);
    expect(parsed.ok).toBe(true);
  });
});

describe('advice', () => {
  const spec = (raw: Record<string, unknown>) => readCreate({ requestId: 'r', title: 'T', ...raw });

  it('names a nested boundary to draw a level down when a view is crowded', () => {
    const inner = Array.from({ length: 6 }, (_, i) => ({ id: `d${i}`, type: 'service', label: `D${i}`, group: 'dom' }));
    const outer = Array.from({ length: 11 }, (_, i) => ({ id: `s${i}`, type: 'service', label: `S${i}`, group: 'sys' }));
    const room = spec({ groups: [{ id: 'sys', label: 'Sys', kind: 'system' }, { id: 'dom', label: 'Dom', kind: 'domain', parent: 'sys' }], nodes: [...outer, ...inner] });
    const advice = adviceFor(room, clean);
    expect(advice.some((a) => a.includes('"sys"') && a.includes('inside'))).toBe(true);
    // Sixteen in all, no boundary over eight: the nested one is what to move down.
    const eight = Array.from({ length: 8 }, (_, i) => ({ id: `d${i}`, type: 'service', label: `D${i}`, group: 'dom' }));
    const lighter = spec({ groups: [{ id: 'sys', label: 'Sys', kind: 'system' }, { id: 'dom', label: 'Dom', kind: 'domain', parent: 'sys' }], nodes: [...outer.slice(0, 8), ...eight] });
    expect(adviceFor(lighter, clean).some((a) => a.includes('"dom"') && a.includes('C4 level down'))).toBe(true);
    expect(adviceFor(spec({ nodes: outer.slice(0, 3).map(({ group: _group, ...n }) => n) }), clean)).toEqual([]);
  });

  it('suggests ungrouping externals only when their connectors show it, with the ops that do it', () => {
    const room = spec({
      groups: [{ id: 'ext', label: 'Providers', kind: 'group' }],
      nodes: [
        { id: 'a', type: 'service', label: 'A' },
        { id: 'b', type: 'service', label: 'B' },
        { id: 'x', type: 'external-system', label: 'X', group: 'ext' },
        { id: 'y', type: 'external-system', label: 'Y', group: 'ext' },
      ],
      relationships: [
        { id: 'ax', from: 'a', to: 'x' },
        { id: 'by', from: 'b', to: 'y' },
      ],
    });
    expect(adviceFor(room, clean)).toEqual([]);
    const [advice] = adviceFor(room, { ...clean, detours: ['by'] });
    expect(advice).toContain('"ext"');
    expect(advice).toContain('{"op":"update","id":"x","set":{"group":null}}');
    expect(advice).toContain('{"op":"arrange"}');
  });

  it('asks for an about on a note that has none, and for a main path when lines are everywhere', () => {
    const room = spec({ nodes: [{ id: 'a', type: 'service', label: 'A' }], notes: [{ id: 'n', text: 'Hi' }] });
    expect(adviceFor(room, clean).some((a) => a.includes('"n"') && a.includes('about'))).toBe(true);
    const busy = adviceFor(spec({ nodes: [{ id: 'a', type: 'service', label: 'A' }] }), { ...clean, crossings: 9 });
    expect(busy.some((a) => a.includes('primaryFlow'))).toBe(true);
  });
});
