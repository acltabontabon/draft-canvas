import { describe, expect, it } from 'vitest';
import { compose } from '../../src/agent/compile';
import { measureContext } from '../../src/agent/place';
import { checkQuality } from '../../src/agent/quality';
import { isotonic, layoutGraph } from '../../src/layout/layered';
import { deserializeDocument } from '../../src/export/project';
import type { DraftDocument, DraftNode } from '../../src/document/types';

function build(raw: Record<string, unknown>): DraftDocument {
  const out = compose({ title: 'T', ...raw }, 'd_layouttest0');
  const parsed = deserializeDocument(out.text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.document;
}

const byId = (doc: DraftDocument, id: string) => doc.nodes.find((n) => n.id === id) as DraftNode;
const cy = (n: DraftNode) => n.y + n.height / 2;
const cx = (n: DraftNode) => n.x + n.width / 2;

const service = (id: string, label = id) => ({ id, type: 'service', label });

describe('layered layout', () => {
  it('isotonic keeps order and separation while staying close to what each box wants', () => {
    const out = isotonic([0, 0, 0], [1, 1, 1], [10, 10]);
    expect(out).toEqual([-10, 0, 10]);
    expect(isotonic([0, 100], [1, 1], [10])).toEqual([0, 100]);
  });

  it('puts a chain on one straight line in the reading direction', () => {
    const doc = build({
      nodes: ['a', 'b', 'c', 'd'].map((id) => service(id)),
      relationships: [
        { id: 'ab', from: 'a', to: 'b' },
        { id: 'bc', from: 'b', to: 'c' },
        { id: 'cd', from: 'c', to: 'd' },
      ],
    });
    const centres = ['a', 'b', 'c', 'd'].map((id) => cy(byId(doc, id)));
    expect(new Set(centres).size).toBe(1);
    const xs = ['a', 'b', 'c', 'd'].map((id) => byId(doc, id).x);
    expect(xs).toEqual([...xs].sort((p, q) => p - q));
    const down = build({ layout: { direction: 'down' }, nodes: ['a', 'b'].map((id) => service(id)), relationships: [{ id: 'ab', from: 'a', to: 'b' }] });
    expect(byId(down, 'b').y).toBeGreaterThan(byId(down, 'a').y);
    expect(cx(byId(down, 'a'))).toBe(cx(byId(down, 'b')));
  });

  it('balances a fan-out around its source and brings a merge back to the middle', () => {
    const doc = build({
      nodes: ['src', 'x', 'y', 'z', 'sink'].map((id) => service(id)),
      relationships: [
        { id: 'sx', from: 'src', to: 'x' },
        { id: 'sy', from: 'src', to: 'y' },
        { id: 'sz', from: 'src', to: 'z' },
        { id: 'xk', from: 'x', to: 'sink' },
        { id: 'yk', from: 'y', to: 'sink' },
        { id: 'zk', from: 'z', to: 'sink' },
      ],
    });
    const middle = cy(byId(doc, 'y'));
    expect(cy(byId(doc, 'src'))).toBe(middle);
    expect(cy(byId(doc, 'sink'))).toBe(middle);
    expect(middle - cy(byId(doc, 'x'))).toBe(cy(byId(doc, 'z')) - middle);
  });

  it('lays out a cycle without changing any connector\'s direction', () => {
    const doc = build({
      nodes: ['a', 'b', 'c'].map((id) => service(id)),
      relationships: [
        { id: 'ab', from: 'a', to: 'b' },
        { id: 'bc', from: 'b', to: 'c' },
        { id: 'ca', from: 'c', to: 'a', label: 'Retry' },
      ],
    });
    const edge = doc.edges.find((e) => e.id === 'ca');
    expect(edge).toMatchObject({ source: 'c', target: 'a' });
    // The return trip runs around the outside, not back through b.
    expect(edge?.sourceAnchor?.side).toBe(edge?.targetAnchor?.side);
  });

  it('sizes a boundary around its members, with room for its title, and keeps non-members out', () => {
    const doc = build({
      groups: [{ id: 'sys', label: 'A rather long system boundary title', kind: 'system' }],
      nodes: [
        { id: 'user', type: 'person', label: 'Customer' },
        { ...service('web', 'Web App'), group: 'sys' },
        { ...service('api', 'API'), group: 'sys' },
        { id: 'db', type: 'database', label: 'Orders', group: 'sys' },
        { id: 'pay', type: 'external-system', label: 'Payment Provider' },
      ],
      relationships: [
        { id: 'u', from: 'user', to: 'web', label: 'Uses' },
        { id: 'w', from: 'web', to: 'api', label: 'Calls' },
        { id: 'a', from: 'api', to: 'db' },
        { id: 'p', from: 'api', to: 'pay', label: 'Charges card' },
      ],
    });
    const sys = byId(doc, 'sys');
    for (const id of ['web', 'api', 'db']) {
      const n = byId(doc, id);
      expect(n.parentId).toBe('sys');
      expect(n.x).toBeGreaterThanOrEqual(sys.x);
      expect(n.y).toBeGreaterThanOrEqual(sys.y + 44);
      expect(n.x + n.width).toBeLessThanOrEqual(sys.x + sys.width);
      expect(n.y + n.height).toBeLessThanOrEqual(sys.y + sys.height);
    }
    for (const id of ['user', 'pay']) {
      const n = byId(doc, id);
      const inside = n.x < sys.x + sys.width && sys.x < n.x + n.width && n.y < sys.y + sys.height && sys.y < n.y + n.height;
      expect(inside).toBe(false);
    }
    expect(checkQuality(doc.nodes, doc.edges, measureContext()).errors).toEqual([]);
  });

  it('widens the gap a long relationship label crosses', () => {
    const short = build({ nodes: [service('a'), service('b')], relationships: [{ id: 'e', from: 'a', to: 'b' }] });
    const long = build({ nodes: [service('a'), service('b')], relationships: [{ id: 'e', from: 'a', to: 'b', label: 'Publishes RepaymentReceived events after validation' }] });
    const gap = (doc: DraftDocument) => byId(doc, 'b').x - (byId(doc, 'a').x + byId(doc, 'a').width);
    expect(gap(long)).toBeGreaterThan(gap(short));
  });

  it('grows a shape for a long name instead of cutting it off', () => {
    const doc = build({ nodes: [{ id: 'a', type: 'service', label: 'Customer Onboarding Orchestration Service', description: 'Coordinates KYC checks, account creation and the welcome journey for every new retail customer.', technology: 'Spring Boot 3, Kotlin' }] });
    const a = byId(doc, 'a');
    expect(a.width * a.height).toBeGreaterThan(176 * 68);
    expect(checkQuality(doc.nodes, doc.edges, measureContext()).errors).toEqual([]);
  });

  it('keeps disconnected parts apart and in input order', () => {
    const doc = build({
      nodes: [service('a'), service('b'), service('c'), service('d'), service('lonely')],
      relationships: [
        { id: 'ab', from: 'a', to: 'b' },
        { id: 'cd', from: 'c', to: 'd' },
      ],
    });
    expect(checkQuality(doc.nodes, doc.edges, measureContext()).errors).toEqual([]);
    expect(byId(doc, 'c').y).toBeGreaterThan(byId(doc, 'a').y);
  });

  it('is deterministic to the pixel', () => {
    const raw = {
      groups: [{ id: 'g', label: 'Group' }],
      nodes: [service('a'), { ...service('b'), group: 'g' }, { ...service('c'), group: 'g' }, service('d')],
      relationships: [
        { id: 'ab', from: 'a', to: 'b' },
        { id: 'ac', from: 'a', to: 'c' },
        { id: 'bd', from: 'b', to: 'd' },
        { id: 'cd', from: 'c', to: 'd' },
        { id: 'da', from: 'd', to: 'a' },
      ],
    };
    const geometry = (doc: DraftDocument) => JSON.stringify([doc.nodes.map((n) => [n.id, n.x, n.y, n.width, n.height]), doc.edges.map((e) => [e.id, e.sourceAnchor, e.targetAnchor])]);
    expect(geometry(build(raw))).toBe(geometry(build(raw)));
  });

  describe('across a boundary', () => {
    const spacing = { layer: 100, sibling: 50, pad: 30, component: 100 };
    const box = (id: string, parent?: string) => ({ id, width: 120, height: 60, ...(parent ? { parent } : {}) });
    const edge = (source: string, target: string) => ({ id: `${source}-${target}`, source, target });
    const group = (id: string, parent?: string) => ({ id, header: 40, minWidth: 0, ...(parent ? { parent } : {}) });

    it('lines an outside shape up with the inner shape it connects to, not the boundary\'s middle', () => {
      // p fans out to q and r inside g, so g's middle is p's line; x is called from r, below it.
      const out = layoutGraph({
        boxes: [box('p', 'g'), box('q', 'g'), box('r', 'g'), box('x')],
        groups: [group('g')],
        edges: [edge('p', 'q'), edge('p', 'r'), edge('r', 'x')],
        direction: 'right',
        spacing,
      });
      const y = (id: string) => out.boxes.get(id)!.y;
      expect(y('r')).not.toBe(y('p'));
      expect(y('x')).toBe(y('r'));
    });

    it('puts a shape whose connector leaves its boundary on the side it leaves by', () => {
      // t is fed from the first layer, but its only other connector goes out of g: it belongs at g's
      // far side (with s), not in the middle where its way out would cross everything after it.
      const out = layoutGraph({
        boxes: [box('p', 'g'), box('q', 'g'), box('s', 'g'), box('t', 'g'), box('x')],
        groups: [group('g')],
        edges: [edge('p', 'q'), edge('q', 's'), edge('p', 't'), edge('t', 'x')],
        direction: 'right',
        spacing,
      });
      expect(out.boxes.get('t')!.x).toBe(out.boxes.get('s')!.x);
      expect(out.boxes.get('t')!.x).toBeGreaterThan(out.boxes.get('q')!.x);
    });

    it('stands a boundary of separately called shapes in a column, each level with its caller', () => {
      const out = layoutGraph({
        boxes: [box('hub'), box('a'), box('b'), box('x1', 'ext'), box('x2', 'ext')],
        groups: [group('ext')],
        edges: [edge('hub', 'a'), edge('hub', 'b'), edge('a', 'x1'), edge('b', 'x2')],
        direction: 'right',
        spacing,
      });
      const at = (id: string) => out.boxes.get(id)!;
      expect(at('x1').x).toBe(at('x2').x);
      expect(at('x1').y).toBe(at('a').y);
      expect(at('x2').y).toBe(at('b').y);
    });

    it('hangs a shape called from the middle of a boundary\'s flow beside its caller, across the flow', () => {
      // q calls x, and still has s after it inside g: x placed after g would be reached across s.
      // It hangs under q instead, level with it, and the layout says which sides that runs between.
      const out = layoutGraph({
        boxes: [box('p', 'g'), box('q', 'g'), box('s', 'g'), box('x')],
        groups: [group('g')],
        edges: [edge('p', 'q'), edge('q', 's'), edge('q', 'x')],
        direction: 'right',
        spacing,
      });
      const at = (id: string) => out.boxes.get(id)!;
      const g = out.groups.get('g')!;
      expect(at('x').y).toBeGreaterThanOrEqual(g.y + g.height + spacing.layer);
      expect(at('x').x).toBe(at('q').x);
      expect(out.sides.get('q-x')).toEqual({ source: 'bottom', target: 'top' });
      expect(out.width).toBe(g.width);
      // Reading down, it hangs to the boundary's right instead.
      const down = layoutGraph({
        boxes: [box('p', 'g'), box('q', 'g'), box('s', 'g'), box('x')],
        groups: [group('g')],
        edges: [edge('p', 'q'), edge('q', 's'), edge('q', 'x')],
        direction: 'down',
        spacing,
      });
      const gd = down.groups.get('g')!;
      expect(down.boxes.get('x')!.x).toBeGreaterThanOrEqual(gd.x + gd.width + spacing.layer);
      expect(down.boxes.get('x')!.y).toBe(down.boxes.get('q')!.y);
      expect(down.sides.get('q-x')).toEqual({ source: 'right', target: 'left' });
    });

    it('keeps a shape called from the end of a boundary\'s flow after it, in the flow', () => {
      const out = layoutGraph({
        boxes: [box('p', 'g'), box('q', 'g'), box('x')],
        groups: [group('g')],
        edges: [edge('p', 'q'), edge('q', 'x')],
        direction: 'right',
        spacing,
      });
      const g = out.groups.get('g')!;
      expect(out.boxes.get('x')!.x).toBeGreaterThanOrEqual(g.x + g.width);
      expect(out.boxes.get('x')!.y).toBe(out.boxes.get('q')!.y);
      expect(out.sides.size).toBe(0);
    });

    it('spreads several satellites of one caller under it, and moves the caller to the edge of its layer', () => {
      // hub shares its layer with r; with three externals hanging off it, it goes to the bottom of
      // that layer so their connectors leave the boundary without passing r.
      const out = layoutGraph({
        boxes: [box('p', 'g'), box('hub', 'g'), box('r', 'g'), box('s', 'g'), box('x1'), box('x2'), box('x3')],
        groups: [group('g')],
        edges: [edge('p', 'hub'), edge('p', 'r'), edge('hub', 's'), edge('hub', 'x1'), edge('hub', 'x2'), edge('hub', 'x3')],
        direction: 'right',
        spacing,
      });
      const at = (id: string) => out.boxes.get(id)!;
      expect(at('hub').y).toBeGreaterThan(at('r').y);
      const xs = ['x1', 'x2', 'x3'].map((id) => at(id).x);
      expect(xs).toEqual([...xs].sort((a, b) => a - b));
      expect(new Set(['x1', 'x2', 'x3'].map((id) => at(id).y)).size).toBe(1);
      expect(at('x2').x).toBe(at('hub').x);
      expect(at('x2').x - at('x1').x).toBeGreaterThanOrEqual(120 + spacing.sibling);
    });

    it('puts a boundary\'s own note under its title, ahead of its flow', () => {
      const out = layoutGraph({
        boxes: [box('p', 'g'), box('q', 'g'), { ...box('n', 'g'), first: true }],
        groups: [group('g')],
        edges: [edge('p', 'q')],
        direction: 'right',
        spacing,
      });
      const at = (id: string) => out.boxes.get(id)!;
      expect(at('n').y + 60).toBeLessThanOrEqual(at('p').y);
      expect(at('p').y - (at('n').y + 60)).toBe(spacing.sibling);
    });
  });

  it('refuses nested groups that form a cycle', () => {
    expect(() =>
      layoutGraph({
        boxes: [{ id: 'a', width: 10, height: 10, parent: 'g1' }],
        groups: [
          { id: 'g1', parent: 'g2', header: 40, minWidth: 0 },
          { id: 'g2', parent: 'g1', header: 40, minWidth: 0 },
        ],
        edges: [],
        direction: 'right',
        spacing: { layer: 100, sibling: 50, pad: 30, component: 100 },
      }),
    ).toThrow();
  });
});
