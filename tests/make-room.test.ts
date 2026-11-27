import { describe, expect, it } from 'vitest';
import { makeRoomBand, viewAcross } from '../src/canvas/makeRoomBand';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { LIMITS } from '../src/document/limits';
import { makeRoom, roomToClose } from '../src/document/makeRoom';
import { addEdges, addNodes, setEdgeWaypoints } from '../src/document/operations';
import { parseDocument } from '../src/document/validate';
import { serializeDocument } from '../src/export/project';

function room() {
  const a = createNode({ id: 'a', type: 'service', x: 0, y: 0, text: 'A' });
  const b = createNode({ id: 'b', type: 'service', x: 400, y: 0, text: 'B' });
  const c = createNode({ id: 'c', type: 'service', x: 800, y: 300, text: 'C' });
  return addEdges(addNodes(createDocument('Room'), [a, b, c]), [createEdge({ id: 'ab', source: 'a', target: 'b' }), createEdge({ id: 'bc', source: 'b', target: 'c' })]);
}
const at = (doc: ReturnType<typeof room>, id: string) => {
  const node = doc.nodes.find((n) => n.id === id)!;
  return { x: node.x, y: node.y, width: node.width, height: node.height };
};

describe('making room', () => {
  it('moves everything past the line and nothing before it', () => {
    const doc = makeRoom(room(), { axis: 'x', at: 300, delta: 120 });
    expect(at(doc, 'a').x).toBe(0);
    expect(at(doc, 'b').x).toBe(520);
    expect(at(doc, 'c')).toMatchObject({ x: 920, y: 300 });
  });

  it('works down the page as well as across it', () => {
    const doc = makeRoom(room(), { axis: 'y', at: 200, delta: 80 });
    expect(at(doc, 'b').y).toBe(0);
    expect(at(doc, 'c').y).toBe(380);
  });

  it('closes room only until the nearest shape past the line reaches it', () => {
    const base = room();
    expect(roomToClose(base, 'x', 300)).toBe(100);
    const doc = makeRoom(base, { axis: 'x', at: 300, delta: -500 });
    expect(at(doc, 'b').x).toBe(300);
    expect(at(doc, 'c').x).toBe(700);
    // Nothing past the line: nothing to close, and the same document back.
    expect(makeRoom(base, { axis: 'x', at: 5000, delta: -50 })).toBe(base);
    expect(makeRoom(base, { axis: 'x', at: 300, delta: 0 })).toBe(base);
  });

  it('stretches a boundary the line passes through, with what it holds past the line', () => {
    const group = createNode({ id: 'g', type: 'group', x: -40, y: -60, width: 700, height: 260, text: 'Zone' });
    const base = addNodes(room(), [group]);
    const doc = makeRoom(base, { axis: 'x', at: 300, delta: 100 });
    expect(at(doc, 'g')).toMatchObject({ x: -40, width: 800 });
    expect(at(doc, 'b').x).toBe(500);
  });

  // Was: a push near the edge of the canvas left a shape, a bend or a stretched boundary past the
  // limits a load keeps, and the next open moved or shrank it back.
  it('keeps what it pushes within the canvas limits, as the next open would', () => {
    const edge = LIMITS.maxCoordinate;
    const far = createNode({ id: 'far', type: 'service', x: edge - 50, y: 0, text: 'Far' });
    const zone = createNode({ id: 'zone', type: 'group', x: -40, y: -60, width: LIMITS.maxNodeSize - 50, height: 260, text: 'Zone' });
    const base = setEdgeWaypoints(addNodes(room(), [far, zone]), 'bc', [{ x: edge - 20, y: 150 }]);
    const doc = makeRoom(base, { axis: 'x', at: 300, delta: 120 });
    expect(at(doc, 'far').x).toBe(edge);
    expect(at(doc, 'zone').width).toBe(LIMITS.maxNodeSize);
    expect(doc.edges.find((e) => e.id === 'bc')!.waypoints).toEqual([{ x: edge, y: 150 }]);
    expect(at(doc, 'c').x).toBe(920);
    const reopened = parseDocument(serializeDocument(doc));
    if (!reopened.ok) throw new Error(reopened.error);
    expect(serializeDocument(reopened.document)).toBe(serializeDocument(doc));
  });

  it('takes a connector’s own bends past the line along', () => {
    const base = setEdgeWaypoints(room(), 'bc', [{ x: 200, y: 150 }, { x: 700, y: 150 }]);
    const doc = makeRoom(base, { axis: 'x', at: 300, delta: 60 });
    expect(doc.edges.find((e) => e.id === 'bc')!.waypoints).toEqual([{ x: 200, y: 150 }, { x: 760, y: 150 }]);
    expect(doc.edges.find((e) => e.id === 'ab')).toBe(base.edges.find((e) => e.id === 'ab'));
  });
});

describe('the band a drag draws', () => {
  const covers = (band: ReturnType<typeof makeRoomBand>, x: number, y: number) =>
    x >= band.left && x <= band.left + band.width && y >= band.top && y <= band.top + band.height;

  it('spans the room made along its axis, and closed room the same way', () => {
    expect(makeRoomBand({ axis: 'x', at: 300, delta: 120 }, 0)).toMatchObject({ left: 300, width: 120 });
    expect(makeRoomBand({ axis: 'x', at: 300, delta: -80 }, 0)).toMatchObject({ left: 220, width: 80 });
    expect(makeRoomBand({ axis: 'y', at: 200, delta: 60 }, 0)).toMatchObject({ top: 200, height: 60 });
  });

  // Coordinates go to a million either way; the band ran 200,000 either side of the origin, so a
  // diagram placed further out than that showed no band at all.
  it('runs through where the view is, however far out the diagram is', () => {
    const viewport = { width: 1600, height: 1000 };
    // A view whose middle is at (900 000, 650 000), at half zoom.
    const transform = [viewport.width / 2 - 900_000 * 0.5, viewport.height / 2 - 650_000 * 0.5, 0.5] as const;
    const across = makeRoomBand({ axis: 'x', at: 900_000, delta: 40 }, viewAcross('x', transform, viewport.width, viewport.height));
    expect(covers(across, 900_020, 650_000)).toBe(true);
    const down = makeRoomBand({ axis: 'y', at: 650_000, delta: 40 }, viewAcross('y', transform, viewport.width, viewport.height));
    expect(covers(down, 900_000, 650_020)).toBe(true);
  });

  it('holds still while the view does, and moves on only once the view has gone a long way', () => {
    const at = (y: number) => viewAcross('x', [0, -y, 1], 1600, 1000);
    expect(at(10_000)).toBe(at(10_400));
    expect(at(10_000)).not.toBe(at(90_000));
  });
});
