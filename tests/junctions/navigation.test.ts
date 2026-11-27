import { describe, expect, it } from 'vitest';
import { createEdge, createNode } from '../../src/document/factory';
import type { DraftEdge, DraftNode } from '../../src/document/types';
import { CONTEXT_LIMIT, CONTEXT_MAX_SPAN, contextSentence, junctionContext } from '../../src/junctions/destination';
import {
  ARRIVAL_MAX_ZOOM,
  ARRIVAL_READABLE_ZOOM,
  FLIGHT_MAX_MS,
  FLIGHT_MIN_MS,
  GLIDE_MAX_MS,
  GLIDE_MIN_MS,
  arrivalFrame,
  easeInOut,
  easeOut,
  journeyOf,
  pathLength,
} from '../../src/junctions/journey';
import { EMPTY_TRAIL, TRAIL_LIMIT, canGoBack, canGoForward, peekStop, step, travel, withoutStop, type TrailStop } from '../../src/junctions/trail';

const service = (id: string, x: number, y: number, extra: Partial<DraftNode> = {}): DraftNode => ({ ...createNode({ id, type: 'service', x, y, text: id }), ...extra });
const junction = (id: string, x: number, y: number, extra: Partial<DraftNode> = {}): DraftNode => ({ ...createNode({ id, type: 'ellipse', x, y }), ...extra });
const edge = (source: string, target: string, extra: Partial<DraftEdge> = {}): DraftEdge => ({ ...createEdge({ id: `${source}-${target}`, source, target }), ...extra });

describe('what surrounds a junction', () => {
  it('is the shapes it is wired to, and one step on the way the connectors run', () => {
    const nodes = [junction('a', 0, 0), service('Partner Adapter', 200, 0), service('External Gateway', 520, 0), service('Unrelated', 60, 200)];
    const context = junctionContext({ nodes, edges: [edge('a', 'Partner Adapter'), edge('Partner Adapter', 'External Gateway')] }, 'a')!;
    expect(context.direction).toBe('continues');
    expect(context.neighbours.map((node) => node.id)).toEqual(['Partner Adapter']);
    expect(context.beyond.map((node) => node.id)).toEqual(['External Gateway']);
    // Wired shapes only: one that merely sits nearby is not context.
    expect(context.contextIds).toEqual(['a', 'Partner Adapter', 'External Gateway']);
    expect(context.edgeIds).toEqual(['a-Partner Adapter', 'Partner Adapter-External Gateway']);
    expect(context.bounds).toEqual({ x: 0, y: 0, width: 520 + nodes[2]!.width, height: Math.max(nodes[0]!.height, nodes[1]!.height) });
    expect(contextSentence(context)).toBe('continues to Partner Adapter → External Gateway');
  });

  it('reads the direction from the connectors, and makes none up', () => {
    const nodes = [junction('a', 400, 0), service('Orders', 0, 0), service('Billing', 800, 0)];
    const into = junctionContext({ nodes, edges: [edge('Orders', 'a')] }, 'a')!;
    expect(into.direction).toBe('arrives');
    expect(contextSentence(into)).toBe('arrives from Orders');
    const through = junctionContext({ nodes, edges: [edge('Orders', 'a'), edge('a', 'Billing')] }, 'a')!;
    expect(through.direction).toBe('through');
    expect(contextSentence(through)).toBe('between Orders, Billing');
    // An undirected line says the two are related, not which way anything flows.
    const undirected = junctionContext({ nodes, edges: [edge('Orders', 'a', { directed: false })] }, 'a')!;
    expect(undirected.direction).toBeNull();
    expect(contextSentence(undirected)).toBe('with Orders');
  });

  it('borrows what is close when it is wired to nothing, and stands alone when nothing is', () => {
    const near = junctionContext({ nodes: [junction('a', 0, 0), service('Ledger', 150, 0), service('Far', 5000, 0), junction('other', 60, 60)], edges: [] }, 'a')!;
    expect(near.borrowed).toBe(true);
    expect(near.direction).toBeNull();
    // Shapes, never another junction.
    expect(near.neighbours.map((node) => node.id)).toEqual(['Ledger']);
    expect(contextSentence(near)).toBe('near Ledger');
    const alone = junctionContext({ nodes: [junction('a', 0, 0), service('Far', 5000, 0)], edges: [] }, 'a')!;
    expect(alone.neighbours).toEqual([]);
    expect(alone.contextIds).toEqual(['a']);
    expect(alone.bounds).toEqual({ x: 0, y: 0, width: 36, height: 36 });
    expect(contextSentence(alone)).toBe('');
  });

  it('names its section, and never frames the section or a huge neighbour for its own sake', () => {
    const lane = { ...createNode({ id: 'lane', type: 'group', x: -200, y: -200, width: 6000, height: 4000, text: 'Payment Execution' }) };
    const wall = service('Wall', 300, -900, { width: 3000, height: 2000 });
    const nodes = [lane, junction('a', 0, 0, { parentId: 'lane' }), service('Adapter', 200, 0, { parentId: 'lane' }), wall];
    const context = junctionContext({ nodes, edges: [edge('a', 'Adapter'), edge('a', 'Wall'), edge('lane', 'a')] }, 'a')!;
    expect(context.section?.id).toBe('lane');
    expect(context.contextIds).toEqual(['a', 'Adapter']);
    expect(context.bounds.width).toBeLessThan(500);
  });

  it('stays bounded: nearest first, a handful at most, never wider than a screen can show', () => {
    const fan = Array.from({ length: 40 }, (_, i) => service(`s${i}`, 200 + (i % 8) * 220, Math.floor(i / 8) * 140));
    const far = service('faraway', 9000, 9000);
    const nodes = [junction('a', 0, 0), ...fan, far];
    const edges = [...fan.map((node) => edge('a', node.id)), edge('a', 'faraway')];
    const context = junctionContext({ nodes, edges }, 'a')!;
    expect(context.contextIds.length).toBeLessThanOrEqual(CONTEXT_LIMIT + 1);
    expect(context.contextIds).not.toContain('faraway');
    expect(context.bounds.width).toBeLessThanOrEqual(CONTEXT_MAX_SPAN.width);
    expect(context.bounds.height).toBeLessThanOrEqual(CONTEXT_MAX_SPAN.height);
    expect(context.neighbours[0]!.id).toBe('s0');
    // A long chain is followed one step past the junction's own neighbours, no further.
    const chain = Array.from({ length: 30 }, (_, i) => service(`c${i}`, 200 + i * 220, 0));
    const chained = junctionContext({ nodes: [junction('a', 0, 0), ...chain], edges: [edge('a', 'c0'), ...chain.slice(1).map((node, i) => edge(`c${i}`, node.id))] }, 'a')!;
    expect(chained.contextIds).toEqual(['a', 'c0', 'c1']);
  });

  it('answers nothing for a junction that is not in the room', () => {
    expect(junctionContext({ nodes: [service('s', 0, 0)], edges: [] }, 'gone')).toBeUndefined();
  });
});

const VIEW = { width: 1440, height: 900 };
const INSETS = { top: 64, right: 56, bottom: 88, left: 56 };
const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
/** Where a point of the room lands on screen under a camera. */
const onScreen = (camera: { x: number; y: number; zoom: number }, x: number, y: number) => ({ x: x * camera.zoom + camera.x, y: y * camera.zoom + camera.y });

describe('where the camera arrives', () => {
  const context = box(4000, 3000, 700, 200);
  const focus = box(4000, 3082, 36, 36);

  it('does not move for a context already comfortably in view', () => {
    const camera = { x: -3600, y: -2700, zoom: 1 };
    expect(arrivalFrame(context, focus, camera, VIEW, INSETS)).toEqual({ camera, kind: 'stay' });
  });

  it('keeps the zoom the person is working at when the context reads well at it', () => {
    const arrival = arrivalFrame(context, focus, { x: 0, y: 0, zoom: 0.9 }, VIEW, INSETS);
    expect(arrival.kind).toBe('pan');
    expect(arrival.camera.zoom).toBe(0.9);
    // Centred in the part of the view the chrome leaves free, not in the pane as a whole.
    const middle = onScreen(arrival.camera, context.x + context.width / 2, context.y + context.height / 2);
    expect(middle.x).toBeCloseTo(INSETS.left + (VIEW.width - INSETS.left - INSETS.right) / 2, 5);
    expect(middle.y).toBeCloseTo(INSETS.top + (VIEW.height - INSETS.top - INSETS.bottom) / 2, 5);
  });

  it('zooms in from an overview, to fit the context and never closer than a few shapes should fill', () => {
    const arrival = arrivalFrame(context, focus, { x: 0, y: 0, zoom: 0.2 }, VIEW, INSETS);
    expect(arrival.kind).toBe('fit');
    expect(arrival.camera.zoom).toBeLessThanOrEqual(ARRIVAL_MAX_ZOOM);
    expect(arrival.camera.zoom).toBeGreaterThanOrEqual(ARRIVAL_READABLE_ZOOM);
    // A junction on its own is not blown up to fill the screen either.
    expect(arrivalFrame(focus, focus, { x: 0, y: 0, zoom: 0.2 }, VIEW, INSETS).camera.zoom).toBe(ARRIVAL_MAX_ZOOM);
  });

  it('backs off when the person is zoomed in closer than the context fits', () => {
    const arrival = arrivalFrame(context, focus, { x: 0, y: 0, zoom: 3 }, VIEW, INSETS);
    expect(arrival.kind).toBe('fit');
    expect(arrival.camera.zoom).toBeLessThanOrEqual(ARRIVAL_MAX_ZOOM);
    expect(context.width * arrival.camera.zoom).toBeLessThanOrEqual(VIEW.width - INSETS.left - INSETS.right);
  });

  it('settles for a readable zoom, with the junction itself in the middle, when the context is too big to read whole', () => {
    const huge = box(0, 0, 9000, 6000);
    const junctionBox = box(8000, 5000, 36, 36);
    const arrival = arrivalFrame(huge, junctionBox, { x: 0, y: 0, zoom: 1 }, VIEW, INSETS);
    expect(arrival.camera.zoom).toBe(ARRIVAL_READABLE_ZOOM);
    const at = onScreen(arrival.camera, 8018, 5018);
    expect(at.x).toBeGreaterThan(INSETS.left);
    expect(at.x).toBeLessThan(VIEW.width - INSETS.right);
    expect(at.y).toBeGreaterThan(INSETS.top);
    expect(at.y).toBeLessThan(VIEW.height - INSETS.bottom);
  });

  it('holds still when the view has no room to frame against', () => {
    const camera = { x: 10, y: 20, zoom: 1 };
    expect(arrivalFrame(context, focus, camera, { width: 0, height: 0 }, INSETS)).toEqual({ camera, kind: 'stay' });
    expect(arrivalFrame(context, focus, camera, { width: 200, height: 200 }, INSETS)).toEqual({ camera, kind: 'stay' });
  });
});

describe('how the camera gets there', () => {
  const at = (cx: number, cy: number, zoom = 1) => ({ x: VIEW.width / 2 - cx * zoom, y: VIEW.height / 2 - cy * zoom, zoom });

  it('is no journey at all when it is already there', () => {
    expect(journeyOf(at(0, 0), at(0, 0), VIEW).kind).toBe('none');
    expect(journeyOf(at(0, 0), at(0, 0), { width: 0, height: 0 }).kind).toBe('none');
  });

  it('glides a short hop: a straight pan, no zooming, quick', () => {
    const near = journeyOf(at(0, 0), at(600, 100), VIEW);
    expect(near.kind).toBe('glide');
    expect(near.interpolate).toBe('linear');
    expect(near.duration).toBeGreaterThanOrEqual(GLIDE_MIN_MS);
    expect(near.duration).toBeLessThanOrEqual(GLIDE_MAX_MS);
    // A shorter hop takes no longer than a longer one.
    expect(journeyOf(at(0, 0), at(150, 0), VIEW).duration).toBeLessThanOrEqual(near.duration);
  });

  it('flies a long way in one eased move, longer the further it goes and never past its ceiling', () => {
    const medium = journeyOf(at(0, 0), at(3200, 600), VIEW);
    const long = journeyOf(at(0, 0), at(40000, 22000), VIEW);
    for (const journey of [medium, long]) {
      expect(journey.kind).toBe('flight');
      expect(journey.interpolate).toBe('smooth');
      expect(journey.duration).toBeGreaterThanOrEqual(FLIGHT_MIN_MS);
      expect(journey.duration).toBeLessThanOrEqual(FLIGHT_MAX_MS);
    }
    expect(long.duration).toBeGreaterThan(medium.duration);
    expect(journeyOf(at(0, 0), at(4_000_000, 0), VIEW).duration).toBe(FLIGHT_MAX_MS);
  });

  it('flies when the zoom changes a lot, even over a short distance', () => {
    expect(journeyOf(at(0, 0, 0.2), at(300, 0, 1.2), VIEW).kind).toBe('flight');
    // …and a pan while zoomed far out is measured in screens, not in the room's units.
    expect(journeyOf(at(0, 0, 0.2), at(2000, 0, 0.2), VIEW).kind).toBe('glide');
  });

  it('measures the path the smooth zoom actually takes', () => {
    // No sideways move: only the zoom changes, and the length is |ln(w1 / w0)| / √2.
    expect(pathLength([0, 0, 1000], [0, 0, 4000])).toBeCloseTo(Math.log(4) / Math.SQRT2, 9);
    expect(pathLength([0, 0, 1000], [0, 0, 1000])).toBe(0);
    // The same either way, and longer for a longer way.
    const there = pathLength([0, 0, 1440], [9000, 3000, 1440]);
    expect(pathLength([9000, 3000, 1440], [0, 0, 1440])).toBeCloseTo(there, 9);
    expect(pathLength([0, 0, 1440], [90000, 30000, 1440])).toBeGreaterThan(there);
    // Checked against d3-interpolate itself: `interpolateZoom([0, 0, 1440], [9000, 3000, 1440]).duration`
    // is 3654.497 ms, at its own pace of 1000 ms per unit of path.
    expect(pathLength([0, 0, 1440], [9000, 3000, 1440])).toBeCloseTo(3.654497, 5);
  });

  it('eases without overshooting', () => {
    for (const ease of [easeOut, easeInOut]) {
      expect(ease(0)).toBe(0);
      expect(ease(1)).toBe(1);
      let previous = 0;
      for (let t = 0; t <= 1.0001; t += 0.05) {
        const value = ease(Math.min(1, t));
        expect(value).toBeGreaterThanOrEqual(previous);
        expect(value).toBeLessThanOrEqual(1);
        previous = value;
      }
    }
  });
});

const stop = (label: string, path: string[] = [], camera = { x: 0, y: 0, zoom: 1 }, junctionId?: string): TrailStop => ({ path, camera, label, ...(junctionId ? { junctionId } : {}) });

describe('the trail', () => {
  it('goes back to where a junction was followed from, and forward again', () => {
    const here = stop('Initiation', [], { x: 1, y: 2, zoom: 0.8 }, 'a1');
    const there = stop('Execution', [], { x: -900, y: -40, zoom: 1 }, 'a2');
    const trail = travel(EMPTY_TRAIL, 'doc', here, there);
    expect(trail.stops).toEqual([here, there]);
    expect(canGoBack(trail, 'doc')).toBe(true);
    expect(canGoForward(trail, 'doc')).toBe(false);
    expect(peekStop(trail, 'doc', -1)).toEqual(here);

    const wandered = { path: [] as string[], camera: { x: -950, y: 10, zoom: 1.4 } };
    const back = step(trail, 'doc', -1, wandered)!;
    expect(back.stop).toEqual(here);
    expect(canGoForward(back.trail, 'doc')).toBe(true);
    // Forward returns to exactly where the camera was when Back was pressed.
    const forward = step(back.trail, 'doc', 1, { path: [], camera: here.camera })!;
    expect(forward.stop.camera).toEqual(wandered.camera);
    expect(forward.stop.junctionId).toBe('a2');
    expect(step(forward.trail, 'doc', 1, wandered)).toBeNull();
    expect(step(back.trail, 'doc', -1, wandered)).toBeNull();
  });

  it('drops what was ahead when a new journey starts from the middle', () => {
    const a = stop('A');
    const b = stop('B');
    const c = stop('C');
    const d = stop('D');
    const two = travel(travel(EMPTY_TRAIL, 'doc', a, b), 'doc', b, c);
    expect(two.stops.map((entry) => entry.label)).toEqual(['A', 'B', 'C']);
    const back = step(two, 'doc', -1, { path: [], camera: c.camera })!;
    const branched = travel(back.trail, 'doc', b, d);
    expect(branched.stops.map((entry) => entry.label)).toEqual(['A', 'B', 'D']);
    expect(canGoForward(branched, 'doc')).toBe(false);
  });

  it('remembers a place wandered to in another room as its own stop', () => {
    const top = stop('Top', []);
    const inside = stop('Inside', ['orders']);
    const first = travel(EMPTY_TRAIL, 'doc', top, inside);
    // Left that room by hand, then followed a junction from the top level.
    const next = travel(first, 'doc', stop('Top again', []), stop('Elsewhere', []));
    expect(next.stops.map((entry) => entry.label)).toEqual(['Top', 'Inside', 'Top again', 'Elsewhere']);
    // Stepping back from a different room does not write this room's camera onto that stop.
    const back = step(next, 'doc', -1, { path: ['orders'], camera: { x: 9, y: 9, zoom: 9 } })!;
    expect(back.trail.stops[3]!.camera).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it('is bounded, forgetting the oldest places first', () => {
    let trail = EMPTY_TRAIL;
    for (let i = 0; i < TRAIL_LIMIT * 3; i += 1) trail = travel(trail, 'doc', stop(`from ${i}`), stop(`to ${i}`));
    expect(trail.stops).toHaveLength(TRAIL_LIMIT);
    expect(trail.index).toBe(TRAIL_LIMIT - 1);
    expect(trail.stops[TRAIL_LIMIT - 1]!.label).toBe(`to ${TRAIL_LIMIT * 3 - 1}`);
  });

  it('belongs to one diagram: another diagram starts with none, and never reads this one’s', () => {
    const trail = travel(EMPTY_TRAIL, 'doc', stop('A'), stop('B'));
    expect(canGoBack(trail, 'other')).toBe(false);
    expect(peekStop(trail, 'other', -1)).toBeUndefined();
    expect(step(trail, 'other', -1, { path: [], camera: { x: 0, y: 0, zoom: 1 } })).toBeNull();
    const fresh = travel(trail, 'other', stop('X'), stop('Y'));
    expect(fresh.documentId).toBe('other');
    expect(fresh.stops.map((entry) => entry.label)).toEqual(['X', 'Y']);
  });

  it('forgets a place that is gone and still knows where you are', () => {
    const a = stop('A');
    const b = stop('B', ['deleted']);
    const c = stop('C');
    const trail = travel(travel(EMPTY_TRAIL, 'doc', a, b), 'doc', b, c);
    const without = withoutStop(trail, trail.stops[1]!);
    expect(without.stops.map((entry) => entry.label)).toEqual(['A', 'C']);
    expect(without.stops[without.index]!.label).toBe('C');
    expect(withoutStop(without, b)).toBe(without);
    expect(withoutStop(travel(EMPTY_TRAIL, 'doc', a, c), a).index).toBe(0);
  });
});
