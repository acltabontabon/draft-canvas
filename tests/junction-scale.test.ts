import { beforeEach, describe, expect, it } from 'vitest';
import { forgetPictures, junctionPicture, keptPicture, keptPictureCount, PICTURE_LIMIT } from '../src/canvas/junctionPreview';
import { destinationsOf, junctionJumpCommands } from '../src/commands/junctions';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import type { DraftDocument, DraftEdge, DraftNode } from '../src/document/types';
import { junctionContext } from '../src/junctions/destination';
import { counterpartsOf, junctionIndex, membersOf } from '../src/junctions/groups';
import { resolveStyle } from '../src/render/style/resolve';
import { renderDocumentSvg } from '../src/render/svg/document';
import { junctionPeerCount } from '../src/store/junctions';

/**
 * Linked Junctions on a diagram the size people actually reach: thousands of shapes, hundreds of
 * groups, one group drawn in a hundred places.
 *
 * Two things are pinned. Bounds that do not depend on the machine: how much a preview draws, how
 * many previews are kept, how much one question walks. And generous ceilings on time, so a change
 * that turns a lookup into a scan of the whole diagram per Junction fails here rather than as a
 * canvas that stutters.
 */

const COLUMNS = 80;

/**
 * `count` services in a grid, wired to their right-hand neighbours; every tenth is preceded by a
 * Junction that feeds it. Junctions are dealt into `groups` groups, and `crowd` of them all share
 * one more.
 */
function large(count: number, groups: number, crowd: number): DraftDocument {
  const nodes: DraftNode[] = [];
  const edges: DraftEdge[] = [];
  let junctions = 0;
  for (let i = 0; i < count; i += 1) {
    const x = (i % COLUMNS) * 320;
    const y = Math.floor(i / COLUMNS) * 220;
    nodes.push(createNode({ id: `s${i}`, type: 'service', x, y, text: `Service ${i}` }));
    if (i % COLUMNS !== COLUMNS - 1 && i + 1 < count) edges.push(createEdge({ id: `e${i}`, source: `s${i}`, target: `s${i + 1}` }));
    if (i % 10 === 0) {
      const link = junctions < crowd ? 'crowd' : `g${junctions % groups}`;
      nodes.push({ ...createNode({ id: `j${junctions}`, type: 'ellipse', x: x - 70, y: y + 16, text: link === 'crowd' ? 'Z' : `G${junctions % groups}` }), link });
      edges.push(createEdge({ id: `je${junctions}`, source: `j${junctions}`, target: `s${i}` }));
      junctions += 1;
    }
  }
  return { ...createDocument('Large'), nodes, edges };
}

/** Wall-clock for `run`, the best of a few goes so one collection pause is not the answer. */
function fastest(run: () => void, goes = 5): number {
  let best = Infinity;
  for (let i = 0; i < goes; i += 1) {
    const start = performance.now();
    run();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

describe('linked junctions at scale', () => {
  const file = large(5000, 200, 100);
  const junctionCount = file.nodes.filter((node) => node.type === 'ellipse').length;

  it('has the diagram it says it has', () => {
    expect(file.nodes.length).toBe(5000 + junctionCount);
    expect(junctionCount).toBe(500);
    expect(membersOf(file, 'crowd')).toHaveLength(100);
    expect(junctionIndex(file).groups.size).toBe(201);
  });

  it('indexes the file once, then answers each junction’s count without walking anything', () => {
    const fresh = { ...file, nodes: [...file.nodes] };
    const build = fastest(() => junctionIndex({ ...fresh, nodes: [...fresh.nodes] }));
    expect(build).toBeLessThan(40);
    const state = { document: file, path: [] as string[], outer: null };
    junctionPeerCount(state, 'crowd');
    // What every Junction on the canvas asks on every store update: all of them, a hundred times over.
    const lookups = fastest(() => {
      for (let round = 0; round < 100; round += 1) for (let i = 0; i < 500; i += 1) junctionPeerCount(state, i < 100 ? 'crowd' : `g${i % 200}`);
    });
    expect(lookups).toBeLessThan(40);
    expect(junctionPeerCount(state, 'crowd')).toBe(99);
  });

  it('reads one junction’s surroundings from its own connectors, not from the diagram', () => {
    junctionContext(file, 'j0');
    const each = fastest(() => {
      for (let i = 0; i < 500; i += 1) junctionContext(file, `j${i}`);
    });
    // Five hundred contexts, on a warm room: well under a frame each.
    expect(each).toBeLessThan(120);
    const context = junctionContext(file, 'j3')!;
    expect(context.contextIds).toEqual(['j3', 's30', 's31']);
  });

  it('lists a hundred destinations, and every junction as a search row, in an instant', () => {
    expect(fastest(() => void destinationsOf(file, 'j0'))).toBeLessThan(60);
    expect(destinationsOf(file, 'j0')).toHaveLength(99);
    expect(counterpartsOf(file, 'j0')[0]!.node.id).toBe('j1');
    expect(fastest(() => void junctionJumpCommands(file))).toBeLessThan(150);
    expect(junctionJumpCommands(file)).toHaveLength(500);
  });
});

describe('a linked junction in an export', () => {
  it('is drawn exactly as a plain one: its circle and its label, and nothing of the link', () => {
    const service = createNode({ id: 's', type: 'service', x: 200, y: 0, text: 'Billing' });
    const plain = createNode({ id: 'j', type: 'ellipse', x: 0, y: 24, text: 'A' });
    const base = { ...createDocument('Export'), metadata: { id: 'export', title: 'Export', createdAt: 1, updatedAt: 1 }, edges: [createEdge({ id: 'e', source: 'j', target: 's' })] };
    const unlinked = renderDocumentSvg({ ...base, nodes: [plain, service] }, { theme: 'light' });
    const linked = renderDocumentSvg({ ...base, nodes: [{ ...plain, link: 'payment' }, service] }, { theme: 'light' });
    expect(linked.svg).toBe(unlinked.svg);
    expect(linked.svg).toContain('>A<');
    expect(linked.svg).not.toContain('payment');
  });
});

describe('a junction’s picture', () => {
  const file = large(5000, 200, 100);
  const style = resolveStyle(undefined, 'clean');

  beforeEach(forgetPictures);

  it('draws the handful of shapes around it and nothing else of a diagram of thousands', () => {
    const context = junctionContext(file, 'j3')!;
    const picture = junctionPicture(file, context, style, 'dark');
    expect(picture.svg).toContain('Service 30');
    expect(picture.svg).toContain('Service 31');
    expect(picture.svg).not.toContain('Service 32');
    expect(picture.svg).not.toContain('Service 4999');
    // The size of its context, not of the diagram.
    expect(picture.width).toBeLessThan(900);
    expect(picture.svg.length).toBeLessThan(40_000);
    // Where the Junction itself sits in the picture, for the ring that points at it.
    expect(picture.focus.width).toBe(36);
    expect(picture.focus.x).toBeGreaterThanOrEqual(0);
    expect(picture.focus.x + picture.focus.width).toBeLessThanOrEqual(picture.width);
    expect(fastest(() => { forgetPictures(); junctionPicture(file, context, style, 'dark'); }, 3)).toBeLessThan(120);
  });

  it('is drawn once and kept until the room, the style or the theme changes', () => {
    const context = junctionContext(file, 'j3')!;
    expect(keptPicture('j3', file, style, 'dark')).toBeUndefined();
    const first = junctionPicture(file, context, style, 'dark');
    expect(junctionPicture(file, context, style, 'dark')).toBe(first);
    expect(keptPicture('j3', file, style, 'dark')).toBe(first);
    // Another theme, another style: not the picture that was kept.
    expect(keptPicture('j3', file, style, 'light')).toBeUndefined();
    expect(keptPicture('j3', file, resolveStyle(undefined, 'sketch'), 'dark')).toBeUndefined();
    // Anything edited in the room, by anyone, gives its lists new identities.
    const edited = { ...file, nodes: file.nodes.map((node) => (node.id === 's30' ? { ...node, text: 'Renamed' } : node)) };
    expect(keptPicture('j3', edited, style, 'dark')).toBeUndefined();
    const redrawn = junctionPicture(edited, junctionContext(edited, 'j3')!, style, 'dark');
    expect(redrawn.svg).toContain('Renamed');
    expect(redrawn.svg).not.toContain('Service 30');
  });

  it('keeps only the last few, however many places are looked at', () => {
    for (let i = 0; i < PICTURE_LIMIT * 3; i += 1) junctionPicture(file, junctionContext(file, `j${i}`)!, style, 'dark');
    expect(keptPictureCount()).toBe(PICTURE_LIMIT);
    // The oldest went first; the newest are still there.
    expect(keptPicture('j0', file, style, 'dark')).toBeUndefined();
    expect(keptPicture(`j${PICTURE_LIMIT * 3 - 1}`, file, style, 'dark')).toBeDefined();
  });
});
