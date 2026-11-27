import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ARRIVAL_MS,
  beginCounterpart,
  destinationsOf,
  followJunction,
  goToJunction,
  junctionCommands,
  junctionJumpCommands,
  junctionKey,
  junctionSelectionCommands,
  placeCounterpart,
  stepTrail,
  trailCommands,
  trailState,
} from '../src/commands/junctions';
import { jumpCommands } from '../src/commands/search';
import { isStage, type CommandContext } from '../src/commands/types';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { createFlow } from '../src/document/flow';
import type { DraftEdge, DraftFlow, DraftNode } from '../src/document/types';
import { membersOf } from '../src/junctions/groups';
import { ARRIVAL_MAX_ZOOM, FLIGHT_MAX_MS, GLIDE_MAX_MS } from '../src/junctions/journey';
import { EMPTY_TRAIL } from '../src/junctions/trail';
import { __resetInteraction, fileOf, useEditorStore } from '../src/store/editorStore';
import { useUiStore } from '../src/store/uiStore';
import { stubContext } from './commandStubs';

const store = useEditorStore;
const junction = (id: string, x: number, y: number, link?: string, text = 'A'): DraftNode => ({ ...createNode({ id, type: 'ellipse', x, y, text }), ...(link ? { link } : {}) });
const service = (id: string, x: number, y: number): DraftNode => createNode({ id, type: 'service', x, y, text: id });
const edge = (source: string, target: string): DraftEdge => createEdge({ id: `${source}>${target}`, source, target });

/**
 * A payment flow drawn in four far-apart places, all continuing at A, and a pair B close together.
 * `orders` has a room of its own with one more A in it.
 */
function open() {
  __resetInteraction();
  const execution = { ...createNode({ id: 'execution', type: 'group', x: 5900, y: 2900, width: 900, height: 300, text: 'Payment Execution' }) };
  const orders: DraftNode = {
    ...service('Order Service', 200, 0),
    inside: { nodes: [junction('a-inside', 40, 40, 'pay'), service('Validator', 240, 40)], edges: [edge('a-inside', 'Validator')], flows: [], viewport: { x: 0, y: 0, zoom: 1 } },
  };
  const nodes = [
    orders,
    junction('a1', 500, 16, 'pay'),
    execution,
    { ...junction('a2', 6000, 3016, 'pay'), parentId: 'execution' },
    { ...service('Partner Adapter', 6200, 3000), parentId: 'execution' },
    service('External Gateway', 6500, 3000),
    junction('a3', 400, 9000, 'pay'),
    service('Reconciliation', 600, 8984),
    junction('b1', 300, 200, 'notify', 'B'),
    junction('b2', 700, 200, 'notify', 'B'),
    service('Notifier', 900, 184),
    junction('plain', 0, 400, undefined, ''),
    junction('waiting', 0, 500, 'solo', 'C'),
  ];
  const edges = [edge('Order Service', 'a1'), edge('a2', 'Partner Adapter'), edge('Partner Adapter', 'External Gateway'), edge('a3', 'Reconciliation'), edge('Order Service', 'b1'), edge('b2', 'Notifier')];
  store.setState({
    document: { ...createDocument('Payments'), nodes, edges },
    path: [],
    outer: null,
    liveViewport: null,
    history: { past: [], future: [] },
    selection: { nodes: [], edges: [] },
    clipboard: null,
    revision: 0,
    mode: 'edit',
    flowPlayback: { active: false, flowId: null, step: 0 },
    focus: { active: false, nodeIds: [], edgeIds: [] },
    selectedFlowId: null,
  });
  useUiStore.setState({ readOnly: null, junctionPeek: null, junctionPlacing: null, junctionTrail: EMPTY_TRAIL, jumpFlashId: null, contextMenu: null, armed: null, pencil: null });
}

/** A camera that remembers where it was last sent, as a real one would be when asked. */
function camera() {
  let at = { x: 0, y: 0, zoom: 1 };
  const setViewport = vi.fn(async (viewport: { x: number; y: number; zoom: number }, _options?: { duration?: number; interpolate?: string; ease?: (t: number) => number }) => {
    at = viewport;
    return true;
  });
  const ctx = (): CommandContext => {
    const base = stubContext();
    return { ...base, camera: { ...base.camera, setViewport, getViewport: () => at, viewWidth: 1440, viewHeight: 900 } };
  };
  return { ctx, setViewport, place: (viewport: { x: number; y: number; zoom: number }) => (at = viewport), at: () => at };
}

/** A camera from which B's second place (x 700–1076) is past the right edge of a 1440-wide view. */
const OFF_TO_ONE_SIDE = { x: 900, y: 300, zoom: 1 };

const file = () => fileOf(store.getState());
const trail = () => useUiStore.getState().junctionTrail;

beforeEach(open);
afterEach(() => vi.useRealTimers());

describe('following a junction', () => {
  it('with one counterpart, goes there at once: a short hop glides at the same zoom', async () => {
    const { ctx, setViewport, place } = camera();
    // The counterpart is just off the right-hand edge of the view.
    place(OFF_TO_ONE_SIDE);
    expect(await followJunction(ctx(), 'b1')).toBe(true);
    expect(useUiStore.getState().junctionPeek).toBeNull();
    expect(setViewport).toHaveBeenCalledTimes(1);
    const [viewport, options] = setViewport.mock.calls[0]!;
    expect(viewport.zoom).toBe(1);
    expect(options).toMatchObject({ interpolate: 'linear' });
    expect(options!.duration).toBeGreaterThan(0);
    expect(options!.duration).toBeLessThanOrEqual(GLIDE_MAX_MS);
    // The destination is framed with what it leads to, not centred on its own.
    const onScreen = (x: number, y: number) => ({ x: x * viewport.zoom + viewport.x, y: y * viewport.zoom + viewport.y });
    expect(onScreen(700, 200).x).toBeGreaterThan(56);
    expect(onScreen(900 + 176, 184).x).toBeLessThan(1440 - 56);
  });

  it('with several, shows them and goes nowhere until one is chosen', async () => {
    const { ctx, setViewport } = camera();
    expect(await followJunction(ctx(), 'a1')).toBe(false);
    expect(setViewport).not.toHaveBeenCalled();
    expect(useUiStore.getState().junctionPeek).toEqual({ id: 'a1', by: 'ask' });
    expect(trail().stops).toEqual([]);

    expect(await followJunction(ctx(), 'a1', 'a2')).toBe(true);
    expect(useUiStore.getState().junctionPeek).toBeNull();
    const [viewport, options] = setViewport.mock.calls[0]!;
    // A long way: one eased flight, bounded in time, arriving no closer than a few shapes should fill.
    expect(options).toMatchObject({ interpolate: 'smooth' });
    expect(options!.duration).toBeGreaterThan(GLIDE_MAX_MS);
    expect(options!.duration).toBeLessThanOrEqual(FLIGHT_MAX_MS);
    expect(viewport.zoom).toBeLessThanOrEqual(ARRIVAL_MAX_ZOOM);
    expect(typeof options!.ease).toBe('function');
  });

  it('lists the places in a fixed order, each with where it is and what it leads to', () => {
    const places = destinationsOf(file(), 'a1');
    expect(places.map((place) => place.member.node.id)).toEqual(['a2', 'a3', 'a-inside']);
    expect(places.map((place) => place.where)).toEqual(['Payment Execution', '', 'inside Order Service']);
    expect(places.map((place) => place.sentence)).toEqual(['continues to Partner Adapter → External Gateway', 'continues to Reconciliation', 'continues to Validator']);
    // Never itself.
    expect(destinationsOf(file(), 'a2').map((place) => place.member.node.id)).not.toContain('a2');
    expect(destinationsOf(file(), 'plain')).toEqual([]);
  });

  it('says so, and moves nothing, for a junction with no counterpart', async () => {
    const { ctx, setViewport } = camera();
    expect(await followJunction(ctx(), 'waiting')).toBe(false);
    expect(await followJunction(ctx(), 'plain')).toBe(false);
    expect(setViewport).not.toHaveBeenCalled();
    expect(useUiStore.getState().toasts.some((toast) => /not linked/.test(toast.message))).toBe(true);
  });

  it('leaves nothing selected, lights the arrival once the camera settles, and lets it fade', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { ctx, setViewport, place } = camera();
    place(OFF_TO_ONE_SIDE);
    store.getState().setSelection({ nodes: ['b1'], edges: [] });
    await followJunction(ctx(), 'b1');
    // What was selected is off to one side now: Delete must not find it there.
    expect(store.getState().selection).toEqual({ nodes: [], edges: [] });
    expect(useUiStore.getState().jumpFlashId).toBeNull();
    const duration = setViewport.mock.calls[0]![1]!.duration!;
    vi.advanceTimersByTime(duration);
    expect(useUiStore.getState().jumpFlashId).toBe('b2');
    vi.advanceTimersByTime(ARRIVAL_MS + 1);
    expect(useUiStore.getState().jumpFlashId).toBeNull();
  });

  it('a second journey started before the first lands takes the arrival with it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { ctx } = camera();
    await followJunction(ctx(), 'a1', 'a2');
    await followJunction(ctx(), 'a2', 'a3');
    vi.advanceTimersByTime(FLIGHT_MAX_MS);
    expect(useUiStore.getState().jumpFlashId).toBe('a3');
    vi.advanceTimersByTime(ARRIVAL_MS + 1);
    expect(useUiStore.getState().jumpFlashId).toBeNull();
  });

  it('does not move for a place already comfortably in view, and still records the visit', async () => {
    const { ctx, setViewport, place } = camera();
    place({ x: 100, y: 200, zoom: 1 });
    await followJunction(ctx(), 'b1');
    expect(setViewport).not.toHaveBeenCalled();
    expect(trail().stops).toHaveLength(2);
  });

  it('goes nowhere when the destination was deleted in the meantime', async () => {
    const { ctx, setViewport } = camera();
    const context = ctx();
    store.getState().setSelection({ nodes: ['b2'], edges: [] });
    store.getState().deleteSelection();
    expect(await goToJunction(context, { id: 'b2', path: [] }, 'b1')).toBe(false);
    expect(setViewport).not.toHaveBeenCalled();
    expect(trail().stops).toEqual([]);
  });

  it('enters the room a counterpart is drawn in, and comes back out of it', async () => {
    const { ctx } = camera();
    expect(await followJunction(ctx(), 'a1', 'a-inside')).toBe(true);
    expect(store.getState().path).toEqual(['Order Service']);
    expect(trail().stops.map((stop) => stop.path)).toEqual([[], ['Order Service']]);
    expect(trail().stops[1]!.label).toBe('A · inside Order Service');
    expect(await stepTrail(ctx(), -1)).toBe(true);
    expect(store.getState().path).toEqual([]);
  });

  it('hands the camera to the presenter rather than fight the guided framing, and selects nothing', async () => {
    const { ctx, place } = camera();
    place(OFF_TO_ONE_SIDE);
    store.setState({ mode: 'present' });
    useUiStore.getState().setPresentation({ framing: 'guided' });
    expect(await followJunction(ctx(), 'b1')).toBe(true);
    expect(useUiStore.getState().presentation.framing).toBe('manual');
    expect(store.getState().mode).toBe('present');
    expect(store.getState().selection).toEqual({ nodes: [], edges: [] });
  });
});

describe('following a junction while presenting', () => {
  const walk: DraftFlow = {
    ...createFlow({ title: 'The diagram' }),
    steps: [
      { id: 'fs1', edgeId: 'Order Service>a1' },
      { id: 'fs2', edgeId: 'Order Service>b1' },
    ],
  };

  function presenting() {
    store.getState().setSelection({ nodes: ['Notifier'], edges: [] });
    store.getState().setMode('present');
    store.getState().setFlowPlayback({ active: true, flowId: walk.id, walk, step: 2 });
  }

  /**
   * A flow belongs to the room it is told in, so stepping into another room ends its playback there.
   * The way back by the trail is what the guide promises carries the presentation on from the step
   * it was on — it had ended, with no flow bar to go on with, and the selection from before
   * presenting was gone too.
   */
  it('carries the presentation on from the step it was on when the trail brings you back', async () => {
    const { ctx } = camera();
    presenting();
    expect(await followJunction(ctx(), 'a1', 'a-inside')).toBe(true);
    expect(store.getState().path).toEqual(['Order Service']);
    expect(store.getState().flowPlayback.active).toBe(false);

    expect(await stepTrail(ctx(), -1)).toBe(true);
    expect(store.getState().path).toEqual([]);
    expect(store.getState().mode).toBe('present');
    expect(store.getState().flowPlayback).toMatchObject({ active: true, flowId: walk.id, walk, step: 2 });

    // There and back again.
    expect(await stepTrail(ctx(), 1)).toBe(true);
    expect(store.getState().flowPlayback.active).toBe(false);
    expect(await stepTrail(ctx(), -1)).toBe(true);
    expect(store.getState().flowPlayback).toMatchObject({ active: true, flowId: walk.id, step: 2 });

    store.getState().setMode('edit');
    expect(store.getState().selection.nodes).toEqual(['Notifier']);
  });

  it('picks nothing up again once the presentation has ended', async () => {
    const { ctx } = camera();
    presenting();
    await followJunction(ctx(), 'a1', 'a-inside');
    store.getState().setMode('edit');
    expect(await stepTrail(ctx(), -1)).toBe(true);
    expect(store.getState().flowPlayback.active).toBe(false);
  });
});

describe('back and forward', () => {
  it('return to the exact view left behind, and to the one left to come back', async () => {
    const { ctx, setViewport, place } = camera();
    const origin = { x: 37, y: -12, zoom: 0.85 };
    place(origin);
    await followJunction(ctx(), 'a1', 'a2');
    const arrived = setViewport.mock.calls[0]![0];
    expect(trailState(ctx()).back?.label).toBe('A');
    expect(trailState(ctx()).forward).toBeUndefined();

    const wandered = { x: arrived.x - 300, y: arrived.y + 80, zoom: arrived.zoom };
    place(wandered);
    expect(await stepTrail(ctx(), -1)).toBe(true);
    expect(setViewport.mock.calls[1]![0]).toEqual(origin);
    expect(trailState(ctx()).forward?.label).toBe('A · Payment Execution');
    expect(await stepTrail(ctx(), -1)).toBe(false);

    expect(await stepTrail(ctx(), 1)).toBe(true);
    expect(setViewport.mock.calls[2]![0]).toEqual(wandered);
    expect(await stepTrail(ctx(), 1)).toBe(false);
  });

  it('are not undo: the document, its history and its revision never change', async () => {
    const { ctx } = camera();
    const before = store.getState();
    await followJunction(ctx(), 'a1', 'a2');
    await followJunction(ctx(), 'a2', 'a3');
    await stepTrail(ctx(), -1);
    await stepTrail(ctx(), 1);
    expect(store.getState().document).toBe(before.document);
    expect(store.getState().history).toBe(before.history);
    expect(store.getState().revision).toBe(before.revision);
    expect(trail().stops.map((stop) => stop.junctionId)).toEqual(['a1', 'a2', 'a3']);
  });

  it('drop a place whose room has since been deleted, and say so', async () => {
    const { ctx } = camera();
    await followJunction(ctx(), 'a1', 'a-inside');
    await stepTrail(ctx(), -1);
    store.getState().setSelection({ nodes: ['Order Service'], edges: [] });
    store.getState().deleteSelection();
    expect(await stepTrail(ctx(), 1)).toBe(false);
    expect(trail().stops.map((stop) => stop.path)).toEqual([[]]);
    expect(useUiStore.getState().toasts.some((toast) => /no longer there/.test(toast.message))).toBe(true);
  });

  it('are offered as commands only while there is somewhere to go, and are safe on a shared diagram', async () => {
    const { ctx } = camera();
    expect(trailCommands(ctx())).toEqual([]);
    await followJunction(ctx(), 'b1');
    expect(trailCommands(ctx()).map((command) => [command.id, command.shortcut])).toEqual([['junction-back', 'Shift G']]);
    await stepTrail(ctx(), -1);
    expect(trailCommands(ctx()).map((command) => command.id)).toEqual(['junction-forward']);
    // A trail laid in another diagram is not this one's.
    store.setState({ document: { ...store.getState().document, metadata: { ...store.getState().document.metadata, id: 'another' } } });
    expect(trailCommands(ctx())).toEqual([]);
  });
});

describe('the Go key', () => {
  it('follows the selected junction, then carries on from wherever it arrived', async () => {
    const { ctx } = camera();
    expect(junctionKey(ctx(), 'follow')).toBe(false);
    store.getState().setSelection({ nodes: ['b1'], edges: [] });
    expect(junctionKey(ctx(), 'follow')).toBe(true);
    await vi.waitFor(() => expect(trail().stops).toHaveLength(2));
    // Nothing is selected on arrival, and the key still knows where it is.
    expect(store.getState().selection.nodes).toEqual([]);
    expect(junctionKey(ctx(), 'follow')).toBe(true);
    await vi.waitFor(() => expect(trail().stops.map((stop) => stop.junctionId)).toEqual(['b1', 'b2', 'b1']));
  });

  it('is left alone for a shape that leads nowhere, and for back and forward with no trail', () => {
    const { ctx } = camera();
    for (const id of ['plain', 'waiting', 'Notifier']) {
      store.getState().setSelection({ nodes: [id], edges: [] });
      expect(junctionKey(ctx(), 'follow')).toBe(false);
    }
    expect(junctionKey(ctx(), 'back')).toBe(false);
    expect(junctionKey(ctx(), 'forward')).toBe(false);
  });

  it('acts on the junction whose places are showing before the selection', () => {
    const { ctx } = camera();
    store.getState().setSelection({ nodes: ['Notifier'], edges: [] });
    useUiStore.getState().setJunctionPeek({ id: 'a1', by: 'hover' });
    expect(junctionKey(ctx(), 'follow')).toBe(true);
    // Several places: resting on it and pressing Go pins the list rather than guessing one.
    expect(useUiStore.getState().junctionPeek).toEqual({ id: 'a1', by: 'ask' });
  });
});

describe('what a junction offers', () => {
  const idsFor = (ctx: CommandContext, id: string) => junctionCommands(ctx, store.getState().document.nodes.find((node) => node.id === id)!).map((command) => command.id);

  it('depends on its link: go there, show the places, or start one', () => {
    const { ctx } = camera();
    expect(idsFor(ctx(), 'b1')).toEqual(['junction-follow', 'junction-add-counterpart', 'junction-link-to', 'junction-unlink']);
    expect(idsFor(ctx(), 'plain')).toEqual(['junction-add-counterpart', 'junction-link-to']);
    expect(idsFor(ctx(), 'waiting')).toEqual(['junction-add-counterpart', 'junction-link-to', 'junction-unlink']);
    expect(idsFor(ctx(), 'Notifier')).toEqual([]);
    const follow = (id: string) => junctionCommands(ctx(), store.getState().document.nodes.find((node) => node.id === id)!)[0]!;
    expect(follow('b1').title).toBe('Go to linked junction');
    expect(follow('a1').title).toBe('Show 3 linked junctions');
    expect(follow('a1').shortcut).toBe('G');
  });

  it('offers to link a junction with the others that read the same, and does it as one group', () => {
    const { ctx } = camera();
    store.getState().addNode({ id: 'loose', type: 'ellipse', x: 50, y: 800, text: 'A' });
    const commands = junctionCommands(ctx(), store.getState().document.nodes.find((node) => node.id === 'loose')!);
    const matching = commands.find((command) => command.id === 'junction-link-matching')!;
    expect(matching.title).toBe('Link with the 4 other “A” junctions');
    matching.run(ctx());
    expect(membersOf(file(), 'pay').map((member) => member.node.id)).toContain('loose');
  });

  it('lists the groups to join as a second step, and joins the one picked', () => {
    const { ctx } = camera();
    const linkTo = junctionCommands(ctx(), store.getState().document.nodes.find((node) => node.id === 'plain')!).find((command) => command.id === 'junction-link-to')!;
    const stage = linkTo.run(ctx());
    if (!isStage(stage)) throw new Error('expected a second step');
    expect(stage.options.map((option) => [option.title, option.hint])).toEqual([
      ['Junction A', '4 places'],
      ['Junction B', '2 places'],
      ['Junction C', '1 place'],
    ]);
    stage.options[1]!.run(ctx());
    expect(membersOf(file(), 'notify').map((member) => member.node.id)).toEqual(['b1', 'b2', 'plain']);
  });

  it('offers nothing that changes the diagram while reading or presenting', () => {
    const { ctx } = camera();
    useUiStore.setState({ readOnly: { sharedTitle: 'Shared' } });
    expect(idsFor(ctx(), 'b1')).toEqual(['junction-follow']);
    expect(idsFor(ctx(), 'plain')).toEqual([]);
    useUiStore.setState({ readOnly: null });
    store.setState({ mode: 'present' });
    expect(idsFor(ctx(), 'b1')).toEqual(['junction-follow']);
    expect(junctionSelectionCommands(ctx())).toEqual([]);
  });

  it('links and unlinks a selection of junctions, and only junctions', () => {
    const { ctx } = camera();
    store.getState().setSelection({ nodes: ['plain', 'waiting'], edges: [] });
    expect(junctionSelectionCommands(ctx()).map((command) => command.id)).toEqual(['junctions-link', 'junctions-unlink']);
    store.getState().setSelection({ nodes: ['b1', 'b2'], edges: [] });
    expect(junctionSelectionCommands(ctx()).map((command) => command.id)).toEqual(['junctions-unlink']);
    store.getState().setSelection({ nodes: ['plain', 'Notifier'], edges: [] });
    expect(junctionSelectionCommands(ctx())).toEqual([]);
  });
});

describe('finding junctions', () => {
  it('lists every linked junction with where it is and what it leads to, and travels there', async () => {
    const { ctx, setViewport } = camera();
    const rows = junctionJumpCommands(file());
    expect(rows.map((row) => [row.title, row.hint])).toEqual([
      ['Junction A', 'arrives from Order Service'],
      ['Junction A', 'Payment Execution · continues to Partner Adapter → External Gateway'],
      ['Junction A', 'continues to Reconciliation'],
      ['Junction A', 'inside Order Service · continues to Validator'],
      ['Junction B', 'arrives from Order Service'],
      ['Junction B', 'continues to Notifier'],
      ['Junction C', 'Junction'],
    ]);
    expect(rows.every((row) => row.group === 'jump' && row.id.startsWith('jump-junction:'))).toBe(true);
    expect(rows[1]!.keywords).toEqual(expect.arrayContaining(['Payment Execution', 'Partner Adapter']));
    rows[1]!.run(ctx());
    await vi.waitFor(() => expect(setViewport).toHaveBeenCalled());
    // Where you were is remembered even though no junction was followed to get there.
    expect(trail().stops.map((stop) => stop.label)).toEqual(['Where you were', 'A · Payment Execution']);
  });

  it('leaves them out of the ordinary rows, so none is listed twice', () => {
    const titles = jumpCommands(store.getState().document).map((row) => row.id);
    expect(titles).toContain('jump-node:plain');
    expect(titles).not.toContain('jump-node:a1');
    expect(titles).not.toContain('jump-node:b2');
  });
});

describe('placing a counterpart', () => {
  it('waits for a click, then puts it down and says what it is linked to', () => {
    const { ctx } = camera();
    beginCounterpart(ctx(), 'plain');
    expect(useUiStore.getState().junctionPlacing).toEqual({ sourceId: 'plain' });
    expect(placeCounterpart({ x: 4000, y: 4000 })).toBe(true);
    expect(useUiStore.getState().junctionPlacing).toBeNull();
    const made = store.getState().document.nodes.find((node) => node.id === store.getState().selection.nodes[0])!;
    // A, B and C are taken.
    expect(made.text).toBe('D');
    expect(useUiStore.getState().toasts.at(-1)!.message).toBe('Junction D now continues in 2 places.');
    expect(placeCounterpart({ x: 0, y: 0 })).toBe(false);
  });

  it('is not offered while reading, and lets go when the junction it was for is deleted', () => {
    const { ctx } = camera();
    useUiStore.setState({ readOnly: { sharedTitle: 'Shared' } });
    beginCounterpart(ctx(), 'plain');
    expect(useUiStore.getState().junctionPlacing).toBeNull();
    useUiStore.setState({ readOnly: null });
    beginCounterpart(ctx(), 'plain');
    store.getState().setSelection({ nodes: ['plain'], edges: [] });
    store.getState().deleteSelection();
    expect(placeCounterpart({ x: 10, y: 10 })).toBe(false);
    expect(useUiStore.getState().toasts.at(-1)!.message).toMatch(/is gone/);
  });
});
