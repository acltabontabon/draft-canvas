import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compose } from '../../src/agent/compile';
import { routingAdvice } from '../../src/agent/advice';
import { legibilityOf } from '../../src/agent/legibility';
import { applyUpdate } from '../../src/agent/patch';
import { relaxLayoutAnchors, routeGeometry } from '../../src/agent/route';
import { createDocument, createEdge, createNode } from '../../src/document/factory';
import type { DraftDocument, DraftEdge } from '../../src/document/types';
import { connectorRoutes } from '../../src/edges/connectorRoutes';
import { deserializeDocument } from '../../src/export/project';
import { agentCorpus } from '../fixtures/routing/corpus';
import { measure, type Quality } from '../fixtures/routing/measure';

/**
 * The agent draws connectors the way a person does: ends automatic unless something needs a pin,
 * pins it asked for kept as given, and receipts that say what to do about a line it couldn't draw.
 */

const create = (request: Record<string, unknown>): DraftDocument => {
  const parsed = deserializeDocument(compose({ requestId: 'arrows', ...request }, 'd_arrows00001').text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.document;
};
const n = (id: string, type = 'service') => ({ id, type, label: id.toUpperCase() });
const r = (id: string, from: string, to: string, extra: Record<string, unknown> = {}) => ({ id, from, to, ...extra });
const drawn = (doc: Pick<DraftDocument, 'nodes' | 'edges'>) => doc.edges.map((e) => connectorRoutes(e, doc, 'transient')!.request.d);

describe('what the agent draws, before and after this routing work', () => {
  it('is no less clear in any view, and clearer across the gallery', { timeout: 120_000 }, () => {
    const before = JSON.parse(readFileSync(resolve(process.cwd(), 'tests/fixtures/routing/agent-before.json'), 'utf8')) as Record<string, Quality['tiers']>;
    let sumBefore = 0;
    let sumAfter = 0;
    for (const fixture of agentCorpus()) {
      const was = before[fixture.id];
      if (!was) continue;
      const now = measure(fixture.nodes, fixture.edges).tiers;
      expect(now.obstruction, fixture.id).toBeLessThanOrEqual(was.obstruction);
      sumBefore += was.obstruction + was.overlap;
      sumAfter += now.obstruction + now.overlap;
    }
    expect(sumAfter).toBeLessThan(sumBefore);
  });
});

describe('connectors the agent draws attach automatically', () => {
  const request = {
    title: 'Orders',
    nodes: [n('web', 'external-actor'), n('api'), n('orders'), n('db', 'sql-database'), n('mail', 'external-system')],
    relationships: [r('r1', 'web', 'api'), r('r2', 'api', 'orders'), r('r3', 'orders', 'db'), r('r4', 'orders', 'mail')],
  };

  it('leaves an end automatic wherever that draws the same line', () => {
    // An end keeps the layout's pin only where an automatic one would draw it differently.
    const doc = create(request);
    const ends = doc.edges.flatMap((e) => [e.sourceAnchor, e.targetAnchor]);
    expect(ends.filter((a) => a === undefined).length).toBeGreaterThanOrEqual(ends.length / 2);
  });

  it('draws the same picture with every layout pin as with the ends it let go', () => {
    const doc = create(request);
    // Pin every end where it is drawn now: the picture must not change.
    const pinned = doc.edges.map((e) => {
      const route = connectorRoutes(e, doc, 'transient')!.request;
      return { ...e, sourceAnchor: e.sourceAnchor ?? { side: route.source.side, offset: 0.5 }, targetAnchor: e.targetAnchor ?? { side: route.target.side, offset: 0.5 } };
    });
    const relaxed = relaxLayoutAnchors(new Set(pinned.map((e) => e.id)), doc.nodes, pinned);
    expect(drawn({ nodes: doc.nodes, edges: relaxed.edges })).toEqual(drawn({ nodes: doc.nodes, edges: pinned }));
  });

  it('follows its shapes when a person moves one across', () => {
    const doc = create({ title: 'Two', nodes: [n('a'), n('b')], relationships: [r('ab', 'a', 'b')] });
    const ab = doc.edges[0]!;
    expect([ab.sourceAnchor, ab.targetAnchor]).toEqual([undefined, undefined]);
    const before = connectorRoutes(ab, doc, 'transient')!.request;
    const a = doc.nodes.find((x) => x.id === 'a')!;
    const b = doc.nodes.find((x) => x.id === 'b')!;
    // B dragged to the far side of A: both ends turn to face each other again.
    const moved = { ...doc, nodes: doc.nodes.map((x) => (x.id === 'b' ? { ...x, x: a.x - (b.x - a.x) } : x)) };
    const after = connectorRoutes(ab, moved, 'transient')!.request;
    expect(after.source.side).not.toBe(before.source.side);
    expect(after.status).toBe('clear');
  });

  it('keeps a pin the request asked for', () => {
    const doc = create({ ...request, relationships: [r('r1', 'web', 'api', { route: { from: 'bottom', to: { side: 'left', offset: 0.25 } } }), ...request.relationships.slice(1)] });
    const r1 = doc.edges.find((e) => e.id === 'r1')!;
    expect(r1.sourceAnchor).toEqual({ side: 'bottom', offset: 0.5 });
    expect(r1.targetAnchor).toEqual({ side: 'left', offset: 0.25 });
  });

  it('never touches a connector an edit did not draw', () => {
    const base = create(request);
    // A person's pins on the existing connectors.
    const pinnedBase: DraftDocument = { ...base, edges: base.edges.map((e) => ({ ...e, sourceAnchor: { side: 'right', offset: 0.75 }, targetAnchor: { side: 'left', offset: 0.25 } })) };
    const { file } = applyUpdate(pinnedBase, [], [{ op: 'add', nodes: [n('audit', 'sql-database')], relationships: [r('r5', 'orders', 'audit')] }], undefined);
    for (const edge of pinnedBase.edges) {
      const now = file.edges.find((e) => e.id === edge.id)!;
      expect([now.sourceAnchor, now.targetAnchor], edge.id).toEqual([edge.sourceAnchor, edge.targetAnchor]);
    }
  });
});

describe('route ends', () => {
  const base = () => create({ title: 'Two', nodes: [n('a'), n('b')], relationships: [r('ab', 'a', 'b')] });

  it('pins a side, pins exactly, and unpins with "auto"', () => {
    let { file } = applyUpdate(base(), [], [{ op: 'update', id: 'ab', set: { route: { from: 'bottom', to: { side: 'top', offset: 0.75 } } } }], undefined);
    let ab = file.edges[0]!;
    expect([ab.sourceAnchor, ab.targetAnchor]).toEqual([{ side: 'bottom', offset: 0.5 }, { side: 'top', offset: 0.75 }]);
    ({ file } = applyUpdate(file, [], [{ op: 'update', id: 'ab', set: { route: { from: 'auto' } } }], undefined));
    ab = file.edges[0]!;
    expect([ab.sourceAnchor, ab.targetAnchor]).toEqual([undefined, { side: 'top', offset: 0.75 }]);
    ({ file } = applyUpdate(file, [], [{ op: 'update', id: 'ab', set: { route: null } }], undefined));
    ab = file.edges[0]!;
    expect([ab.sourceAnchor, ab.targetAnchor, ab.waypoints]).toEqual([undefined, undefined, undefined]);
  });

  it('refuses an offset outside the side', () => {
    expect(() => applyUpdate(base(), [], [{ op: 'update', id: 'ab', set: { route: { from: { side: 'top', offset: 1.5 } } } }], undefined)).toThrow(/offset/);
  });

  it('reads back which ends are pinned', () => {
    const { file } = applyUpdate(base(), [], [{ op: 'update', id: 'ab', set: { route: { to: { side: 'left', offset: 0.25 } } } }], undefined);
    const geometry = routeGeometry(file.edges[0]!, file.nodes, file.edges)!;
    expect(geometry.pins).toEqual({ to: 0.25 });
  });
});

describe('a receipt about a line the agent could not draw clear', () => {
  it('names the pin and gives the op that frees it, which then works', () => {
    // A walled-in target, pinned from a side facing away.
    const nodes = [
      createNode({ id: 'a', type: 'service', x: 0, y: 200 }),
      createNode({ id: 't', type: 'service', x: 600, y: 200 }),
      ...[[560, 120, 240, 60], [560, 300, 240, 60], [540, 120, 40, 240], [780, 120, 40, 240]].map(([x, y, width, height], i) => createNode({ id: `w${i}`, type: 'service', x: x!, y: y!, width, height })),
    ];
    const edges: DraftEdge[] = [createEdge({ id: 'at', source: 'a', target: 't', targetAnchor: { side: 'left', offset: 0.5 } })];
    const view: DraftDocument = { ...createDocument('Walled'), nodes, edges };
    const legibility = legibilityOf(nodes, edges);
    expect(legibility.unresolved).toEqual(['at']);
    const advice = routingAdvice(view, legibility, new Set(['at']));
    expect(advice[0]).toContain('"route":{"to":"auto"}');
    const op = JSON.parse(advice[0]!.match(/\{"op":"update".*?\}\}\}/)![0]);
    const { file } = applyUpdate(view, [], [op], undefined);
    expect(file.edges[0]!.targetAnchor).toBeUndefined();
  });
});
