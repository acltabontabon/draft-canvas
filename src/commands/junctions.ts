/**
 * Following a Junction to where it continues, and coming back.
 *
 * Every way in — the Go key, the peek card, the inspector, the context menu, the palette's search,
 * a click while presenting — arrives here, so each one frames the destination the same way, flies
 * the same journey, leaves the same trail and lights the same arrival.
 *
 * The decisions are made elsewhere and are pure: what surrounds a Junction (`junctions/destination`),
 * where the camera stops and how it gets there (`junctions/journey`), where you have been
 * (`junctions/trail`). This file only reads the stores and moves the camera. It changes no
 * document: following, going back and going forward are navigation, never an edit.
 */
import { displayNameFor } from '../document/factory';
import { playbackFlowOf } from '../document/sequenceFlow';
import type { DraftDocument, DraftNode, DraftViewport } from '../document/types';
import { resolvePath, samePath, viewOf, type DepthPath } from '../depth/tree';
import { contextSentence, junctionContext, type JunctionContext } from '../junctions/destination';
import { counterpartsOf, groupLabel, junctionGroups, junctionOf, membersOf, sameLabelJunctions, type JunctionMember } from '../junctions/groups';
import { arrivalFrame, journeyOf, type Insets, type Journey } from '../junctions/journey';
import { canGoBack, canGoForward, EMPTY_TRAIL, peekStop, step, travel, withoutStop, type TrailStop } from '../junctions/trail';
import { announce } from '../lib/announce';
import { motionMs } from '../lib/motion';
import { count } from '../lib/plural';
import { PRESENTATION_INSETS } from '../presentation/useFlowPlayback';
import { fileOf, useEditorStore, type EditorStore, type FlowPlaybackState } from '../store/editorStore';
import { useUiStore } from '../store/uiStore';
import { navigateToRoom } from './depthNavigation';
import type { Command, CommandContext, CommandOption, CommandStage } from './types';

/** Room the editor's own chrome needs: the toolbar above, the status bar and the trail below. */
const EDIT_INSETS: Insets = { top: 64, right: 56, bottom: 88, left: 56 };
/** `FlowPanel`'s footprint while it is open (`canvas/canvasFrame.ts`): 12 + 300 + 12. */
const FLOW_PANEL = 324;

/** How far into the journey the arrival ring starts, so it is opening as the camera settles. */
const ARRIVAL_LEAD = 0.72;
/** How long the arrival stays lit. Matches `dc-junction-arrive` in `canvas.css`. */
export const ARRIVAL_MS = 1100;

function insetsFor(ctx: CommandContext): Insets {
  if (ctx.editor.mode === 'present') return PRESENTATION_INSETS;
  return ctx.ui.flowPanelOpen ? { ...EDIT_INSETS, right: FLOW_PANEL } : EDIT_INSETS;
}

/** The context as it is now: a command's own `ctx` is a snapshot from before any room change. */
function fresh(ctx: CommandContext): CommandContext {
  return { ...ctx, editor: useEditorStore.getState(), ui: useUiStore.getState() };
}

/** The room a member is drawn in, as a graph to read its surroundings from. */
function roomOf(file: DraftDocument, path: DepthPath): DraftDocument | undefined {
  return viewOf(file, path);
}

/** Where a Junction is, in words: its section, else the shape whose inside it is in. */
export function whereOf(member: JunctionMember, context: JunctionContext | undefined): string {
  const section = context?.section ? displayNameFor(context.section).trim() : '';
  const owner = member.owners[member.owners.length - 1];
  const inside = owner ? `inside ${displayNameFor(owner)}` : '';
  return [section, inside].filter(Boolean).join(' · ');
}

/** How a Junction is named where a label alone would not do: "Junction A", or "Junction". */
export function junctionName(node: Pick<DraftNode, 'text'>): string {
  const label = node.text?.trim();
  return label ? `Junction ${label}` : 'Junction';
}

/** One place a Junction continues, with what is needed to list it, preview it and go there. */
export interface JunctionDestination {
  member: JunctionMember;
  context: JunctionContext | undefined;
  /** "Payment Execution · inside Orders API", or empty at the top level outside any section. */
  where: string;
  /** "continues to Partner Adapter, External Gateway", or empty when it is wired to nothing. */
  sentence: string;
}

/** Everywhere `id` continues, in the order `counterpartsOf` gives: a stable list, read fresh. */
export function destinationsOf(file: DraftDocument, id: string): JunctionDestination[] {
  return counterpartsOf(file, id).map((member) => {
    const room = roomOf(file, member.path);
    const context = room ? junctionContext(room, member.node.id) : undefined;
    return { member, context, where: whereOf(member, context), sentence: context ? contextSentence(context) : '' };
  });
}

function stopLabel(member: JunctionMember, context: JunctionContext | undefined): string {
  const where = whereOf(member, context);
  const label = member.node.text?.trim() || 'Junction';
  return where ? `${label} · ${where}` : label;
}

/**
 * What was being presented in a place a journey left, kept with that place on the trail. A flow is
 * told in its own room: stepping into another lets its playback go, since nothing of it is there to
 * show. Coming back by the trail carries it on from the step it was on, as the guide promises; it
 * used to end there, flow bar and all. As transient as the trail: never saved, undone or shared.
 */
interface Telling {
  path: DepthPath;
  playback: Pick<FlowPlaybackState, 'flowId' | 'sequenceNodeId' | 'walk' | 'step' | 'stage'>;
  selectedFlowId: string | null;
}

const toldAt = new WeakMap<TrailStop, Telling>();

/** The presentation under way, if one is being told, to carry on with on the way back. */
function tellingOf(editor: EditorStore): Telling | undefined {
  const { mode, flowPlayback, selectedFlowId, path } = editor;
  if (mode !== 'present' || !flowPlayback.active || flowPlayback.flowId === null) return undefined;
  const { flowId, sequenceNodeId, walk, step: at, stage } = flowPlayback;
  return { path, playback: { flowId, sequenceNodeId, walk, step: at, stage }, selectedFlowId };
}

/** Carries on with what was being told at `stop`, once back in its room, while presenting and if it is still there. */
function resumeTelling(stop: TrailStop): void {
  const told = toldAt.get(stop);
  if (!told) return;
  toldAt.delete(stop);
  const editor = useEditorStore.getState();
  if (editor.mode !== 'present' || editor.flowPlayback.active || !samePath(editor.path, told.path)) return;
  const { flowId, sequenceNodeId, walk } = told.playback;
  if (!playbackFlowOf(editor.document, flowId, sequenceNodeId, walk)) return;
  editor.setFlowPlayback({ active: true, ...told.playback });
  if (told.selectedFlowId !== null && editor.document.flows.some((flow) => flow.id === told.selectedFlowId)) editor.setSelectedFlowId(told.selectedFlowId);
}

let arrivalTimer: ReturnType<typeof setTimeout> | null = null;
let flashTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Lights a Junction as the camera settles on it. One arrival at a time: a second journey started
 * before the first has landed takes the ring with it rather than leaving two.
 */
function lightArrival(id: string, journey: Journey): void {
  if (arrivalTimer) clearTimeout(arrivalTimer);
  if (flashTimer) clearTimeout(flashTimer);
  const ui = useUiStore.getState();
  ui.setJumpFlashId(null);
  arrivalTimer = setTimeout(
    () => {
      arrivalTimer = null;
      useUiStore.getState().setJumpFlashId(id);
      flashTimer = setTimeout(() => {
        flashTimer = null;
        if (useUiStore.getState().jumpFlashId === id) useUiStore.getState().setJumpFlashId(null);
      }, ARRIVAL_MS);
    },
    // The journey as the camera takes it: under reduced motion the camera jumps at once (`calm`), and
    // a delay worked out from the full journey lit the ring up to 600 ms after the jump.
    Math.round(motionMs(journey.duration) * ARRIVAL_LEAD),
  );
}

/** Moves the camera along `journey`. A presenter's guided framing steps aside: this is their move. */
function fly(ctx: CommandContext, to: DraftViewport, journey: Journey): void {
  if (journey.kind === 'none') return;
  if (ctx.editor.mode === 'present' && ctx.ui.presentation.framing !== 'manual') ctx.ui.setPresentation({ framing: 'manual' });
  void ctx.camera.setViewport(to, { duration: journey.duration, interpolate: journey.interpolate, ease: journey.ease });
}

/** Two frames: long enough for the canvas to have drawn the room just entered and set its camera. */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== 'function') resolve();
    else requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/** Stands in `path`, and says where the camera is once there. `null` when the room refused. */
async function enter(ctx: CommandContext, path: DepthPath): Promise<CommandContext | null> {
  if (samePath(ctx.editor.path, path)) return ctx;
  if (!(await navigateToRoom(path))) return null;
  // The room's own arrival (fit to view, and the picture of stepping in) sets the camera first.
  await nextPaint();
  return fresh(ctx);
}

/**
 * Goes to a Junction, wherever in the file it is.
 *
 * `fromId` is the Junction this was followed from, when it was: it is what Back returns to and
 * points out. Without one (a search result), where you were is remembered all the same.
 * `false` when nothing moved: the Junction is gone, or its room could not be entered.
 */
export async function goToJunction(ctx: CommandContext, target: { id: string; path: DepthPath }, fromId?: string): Promise<boolean> {
  const start = fresh(ctx);
  const file = fileOf(start.editor);
  const destination = junctionOf(file, target.id);
  if (!destination) return false;
  const origin = fromId ? junctionOf(file, fromId) : undefined;
  const originRoom = origin ? roomOf(file, origin.path) : undefined;
  const here: TrailStop = {
    path: start.editor.path,
    camera: start.camera.getViewport(),
    ...(origin ? { junctionId: origin.node.id } : {}),
    label: origin ? stopLabel(origin, originRoom ? junctionContext(originRoom, origin.node.id) : undefined) : 'Where you were',
  };
  start.ui.setJunctionPeek(null);
  if (start.ui.contextMenu) start.ui.setContextMenu(null);
  const telling = samePath(start.editor.path, destination.path) ? undefined : tellingOf(start.editor);

  const there = await enter(start, destination.path);
  if (!there) return false;
  const context = junctionContext(there.editor.document, target.id);
  // Deleted while the room was being entered, by this person's undo or somebody else's edit.
  if (!context) return false;

  const view = { width: there.camera.viewWidth, height: there.camera.viewHeight };
  const camera = there.camera.getViewport();
  const arrival = arrivalFrame(context.bounds, context.node, camera, view, insetsFor(there));
  const journey = journeyOf(camera, arrival.camera, view);
  fly(there, arrival.camera, journey);

  const documentId = there.editor.document.metadata.id;
  const member = { ...destination, node: context.node };
  there.ui.setJunctionTrail(
    travel(there.ui.junctionTrail, documentId, here, { path: destination.path, camera: arrival.camera, junctionId: target.id, label: stopLabel(member, context) }),
  );
  if (telling) toldAt.set(here, telling);
  // Nothing is left selected: what was selected is off screen now, where Delete must not find it,
  // and selecting the destination would put its inspector over the place just arrived at. The Go
  // key carries on from here all the same (`junctionKey`).
  if (there.editor.selection.nodes.length > 0 || there.editor.selection.edges.length > 0) there.editor.setSelection({ nodes: [], edges: [] });
  lightArrival(target.id, journey);

  const where = whereOf(member, context);
  const sentence = contextSentence(context);
  announce([`${junctionName(context.node)}${where ? `, ${where}` : ''}`, sentence].filter(Boolean).join('. '));
  return true;
}

/**
 * Follows the Junction `fromId`.
 *
 * With one counterpart it goes there at once. With several and no `toId`, it shows them and goes
 * nowhere: which place is the person's choice, not a default. `false` when nothing moved.
 */
export async function followJunction(ctx: CommandContext, fromId: string, toId?: string): Promise<boolean> {
  const now = fresh(ctx);
  const counterparts = counterpartsOf(fileOf(now.editor), fromId);
  if (counterparts.length === 0) {
    now.ui.notify('This junction is not linked to another one yet.');
    return false;
  }
  if (!toId && counterparts.length > 1) {
    now.ui.setJunctionPeek({ id: fromId, by: 'ask' });
    return false;
  }
  const target = toId ? counterparts.find((member) => member.node.id === toId) : counterparts[0];
  if (!target) return false;
  return goToJunction(now, { id: target.node.id, path: target.path }, fromId);
}

/**
 * One place back or forward along the trail. The camera returns to exactly where it was, in the
 * room it was in, and the Junction that was followed there is pointed out. `false` at either end.
 */
export async function stepTrail(ctx: CommandContext, direction: -1 | 1): Promise<boolean> {
  const start = fresh(ctx);
  const documentId = start.editor.document.metadata.id;
  const moved = step(start.ui.junctionTrail, documentId, direction, { path: start.editor.path, camera: start.camera.getViewport() });
  if (!moved) return false;
  const file = fileOf(start.editor);
  if (resolvePath(file, moved.stop.path).length !== moved.stop.path.length) {
    // The shape whose inside it was in has been deleted since.
    start.ui.setJunctionTrail(withoutStop(start.ui.junctionTrail, moved.stop));
    start.ui.notify('That part of the diagram is no longer there.');
    return false;
  }
  start.ui.setJunctionPeek(null);
  const leaving = !samePath(start.editor.path, moved.stop.path);
  const telling = leaving ? tellingOf(start.editor) : undefined;
  const there = await enter(start, moved.stop.path);
  if (!there) return false;
  there.ui.setJunctionTrail(moved.trail);
  // Kept with the place being left as the trail now holds it (`step` writes the camera on it).
  const left = moved.trail.stops[start.ui.junctionTrail.index];
  if (telling && left) toldAt.set(left, telling);

  const view = { width: there.camera.viewWidth, height: there.camera.viewHeight };
  const journey = journeyOf(there.camera.getViewport(), moved.stop.camera, view);
  fly(there, moved.stop.camera, journey);
  if (leaving) resumeTelling(moved.stop);

  if (there.editor.selection.nodes.length > 0 || there.editor.selection.edges.length > 0) there.editor.setSelection({ nodes: [], edges: [] });
  const junction = moved.stop.junctionId ? there.editor.document.nodes.find((node) => node.id === moved.stop.junctionId) : undefined;
  if (junction) lightArrival(junction.id, journey);
  announce(`${direction < 0 ? 'Back to' : 'Forward to'} ${moved.stop.label}`);
  return true;
}

export type JunctionKeyAction = 'follow' | 'back' | 'forward';

/**
 * What the Go key does right now. `follow` acts on the Junction whose places are showing, else the
 * one selected. `false` when there is nothing to do, so the key is left for anything else.
 */
export function junctionKey(ctx: CommandContext, action: JunctionKeyAction): boolean {
  if (action !== 'follow') {
    const { back, forward } = trailState(ctx);
    if (!(action === 'back' ? back : forward)) return false;
    void stepTrail(ctx, action === 'back' ? -1 : 1);
    return true;
  }
  const { nodes, edges } = ctx.editor.selection;
  const documentId = ctx.editor.document?.metadata?.id;
  const trail = ctx.ui.junctionTrail ?? EMPTY_TRAIL;
  // The Junction whose places are showing, else the one selected, else — with nothing selected —
  // the one just arrived at, so a chain of Junctions is followed one press at a time.
  const arrived = nodes.length + edges.length === 0 && trail.documentId === documentId ? trail.stops[trail.index] : undefined;
  const id =
    ctx.ui.junctionPeek?.id ??
    (nodes.length === 1 && edges.length === 0 ? nodes[0] : undefined) ??
    (arrived && samePath(arrived.path, ctx.editor.path) ? arrived.junctionId : undefined);
  const node = id ? ctx.editor.document.nodes.find((candidate) => candidate.id === id) : undefined;
  if (!node?.link || counterpartsOf(fileOf(ctx.editor), node.id).length === 0) return false;
  void followJunction(ctx, node.id);
  return true;
}

/** Starts placing a counterpart of `sourceId`: the next click on the canvas puts it down. */
export function beginCounterpart(ctx: CommandContext, sourceId: string): void {
  const now = fresh(ctx);
  if (now.ui.readOnly || now.editor.mode !== 'edit') return;
  now.ui.setJunctionPlacing({ sourceId });
  announce('Click where the linked junction goes. Escape cancels.');
}

/**
 * Puts the waiting counterpart down, centred on `center` (the room's own coordinates), and says
 * what it is now linked to. `false` when nothing was waiting or it could not be placed.
 */
export function placeCounterpart(center: { x: number; y: number }): boolean {
  const ui = useUiStore.getState();
  const placing = ui.junctionPlacing;
  if (!placing) return false;
  ui.setJunctionPlacing(null);
  const editor = useEditorStore.getState();
  const node = editor.addJunctionCounterpart(placing.sourceId, center);
  if (!node) {
    if (!junctionOf(fileOf(editor), placing.sourceId)) ui.notify('The junction it was linked to is gone.');
    return false;
  }
  const places = membersOf(fileOf(useEditorStore.getState()), node.link).length;
  const message = `${junctionName(node)} now continues in ${count(places, 'place')}.`;
  ui.notify(message);
  return true;
}

/** Whether Back and Forward have somewhere to go, and what they would say. */
export function trailState(ctx: Pick<CommandContext, 'editor' | 'ui'>): { back: TrailStop | undefined; forward: TrailStop | undefined } {
  // Both guarded: the shortcut sheet builds its catalogue from a stand-in context with neither.
  const documentId = ctx.editor.document?.metadata?.id;
  const trail = ctx.ui.junctionTrail ?? EMPTY_TRAIL;
  if (!documentId) return { back: undefined, forward: undefined };
  return {
    back: canGoBack(trail, documentId) ? peekStop(trail, documentId, -1) : undefined,
    forward: canGoForward(trail, documentId) ? peekStop(trail, documentId, 1) : undefined,
  };
}

/** Back and Forward, wherever commands are listed — while editing, reading or presenting. */
export function trailCommands(ctx: CommandContext): Command[] {
  const { back, forward } = trailState(ctx);
  const commands: Command[] = [];
  if (back) {
    commands.push({
      id: 'junction-back',
      title: 'Go back',
      group: 'view',
      hint: back.label,
      keywords: ['junction', 'previous', 'return', 'history', 'navigate'],
      shortcut: 'Shift G',
      run: (inner) => void stepTrail(inner, -1),
    });
  }
  if (forward) {
    commands.push({
      id: 'junction-forward',
      title: 'Go forward',
      group: 'view',
      hint: forward.label,
      keywords: ['junction', 'next', 'history', 'navigate'],
      shortcut: 'Alt G',
      run: (inner) => void stepTrail(inner, 1),
    });
  }
  return commands;
}

/**
 * Every linked Junction in the file as a "Jump to" row: "Junction A", said with where it is and
 * what it leads to, so three places all called A can be told apart. Picking one travels there the
 * way following a Junction does. Built here rather than in `search.ts`, which lists every other
 * shape: these rows need the journey, and that module must not come to depend on this one.
 */
export function junctionJumpCommands(file: DraftDocument): Command[] {
  const commands: Command[] = [];
  for (const group of junctionGroups(file)) {
    for (const member of membersOf(file, group.link)) {
      const room = roomOf(file, member.path);
      const context = room ? junctionContext(room, member.node.id) : undefined;
      const where = whereOf(member, context);
      const sentence = context ? contextSentence(context) : '';
      commands.push({
        id: `jump-junction:${member.node.id}`,
        title: junctionName(member.node),
        group: 'jump',
        keywords: ['junction', 'linked', ...(context?.section ? [displayNameFor(context.section)] : []), ...member.owners.map(displayNameFor), ...(context?.neighbours.map(displayNameFor) ?? [])],
        // The title already says it is a Junction; the hint is where, and what it leads to.
        hint: [where, sentence].filter(Boolean).join(' · ') || 'Junction',
        run: (ctx) => void goToJunction(ctx, { id: member.node.id, path: member.path }),
      });
    }
  }
  return commands;
}

/** The groups a Junction could join, as a second step in the palette. */
function linkToStage(ctx: CommandContext, node: DraftNode): CommandStage {
  const file = fileOf(ctx.editor);
  const options: CommandOption[] = junctionGroups(file)
    .filter((group) => group.link !== node.link)
    .map((group) => ({
      id: `junction-join:${group.link}`,
      title: group.label ? `Junction ${group.label}` : 'Unnamed junctions',
      hint: count(group.count, 'place'),
      run: (inner) => {
        inner.editor.linkJunctions([node.id], group.link);
      },
    }));
  return { prompt: 'Link to', options };
}

/**
 * What a selected Junction offers. The first is the one the inspector shows as its action: go
 * where it continues, or, for one linked to nothing, start a link.
 */
export function junctionCommands(ctx: CommandContext, node: DraftNode): Command[] {
  if (node.type !== 'ellipse') return [];
  const file = fileOf(ctx.editor);
  const commands: Command[] = [];
  const counterparts = node.link ? counterpartsOf(file, node.id) : [];
  const editing = ctx.editor.mode === 'edit' && !ctx.ui.readOnly;

  if (counterparts.length > 0) {
    const single = counterparts.length === 1 ? counterparts[0]! : null;
    commands.push({
      id: 'junction-follow',
      title: single ? 'Go to linked junction' : `Show ${counterparts.length} linked junctions`,
      group: 'selection',
      primary: true,
      hint: single ? whereOf(single, undefined) || undefined : undefined,
      keywords: ['junction', 'follow', 'jump', 'continue', 'counterpart', 'destination', 'navigate', 'definition'],
      shortcut: 'G',
      run: (inner) => void followJunction(inner, node.id),
    });
  }
  if (!editing) return commands;

  commands.push({
    id: 'junction-add-counterpart',
    title: 'Add linked junction',
    group: 'selection',
    primary: true,
    hint: 'Click where it continues',
    keywords: ['junction', 'counterpart', 'link', 'continue', 'off-page', 'connector', 'continuation'],
    run: (inner) => beginCounterpart(inner, node.id),
  });

  const matching = sameLabelJunctions(file, node.id);
  if (matching.length > 0) {
    const label = node.text?.trim() ?? '';
    commands.push({
      id: 'junction-link-matching',
      title: matching.length === 1 ? `Link with the other “${label}” junction` : `Link with the ${matching.length} other “${label}” junctions`,
      group: 'selection',
      keywords: ['junction', 'link', 'same', 'label', 'match'],
      run: (inner) => {
        inner.editor.linkJunctions([node.id, ...matching.map((member) => member.node.id)]);
      },
    });
  }
  if (junctionGroups(file).some((group) => group.link !== node.link)) {
    commands.push({
      id: 'junction-link-to',
      title: 'Link to junction group…',
      group: 'selection',
      keywords: ['junction', 'link', 'join', 'group', 'existing'],
      run: (inner) => linkToStage(inner, node),
    });
  }
  if (node.link) {
    commands.push({
      id: 'junction-unlink',
      title: 'Unlink junction',
      group: 'selection',
      hint: counterparts.length > 0 ? `Leaves ${groupLabel(membersOf(file, node.link)) || 'its group'}` : undefined,
      keywords: ['junction', 'unlink', 'detach', 'leave', 'group', 'standalone'],
      run: (inner) => {
        inner.editor.unlinkJunctions([node.id]);
      },
    });
  }
  return commands;
}

/** With two or more Junctions selected and nothing else: make them one group. */
export function junctionSelectionCommands(ctx: CommandContext): Command[] {
  if (ctx.editor.mode !== 'edit' || ctx.ui.readOnly) return [];
  const { nodes, edges } = ctx.editor.selection;
  if (nodes.length < 2 || edges.length > 0) return [];
  const selected = nodes.map((id) => ctx.editor.document.nodes.find((node) => node.id === id));
  if (!selected.every((node): node is DraftNode => node?.type === 'ellipse')) return [];
  const links = new Set(selected.map((node) => node.link));
  const commands: Command[] = [];
  // Already one group and nothing else: there is nothing left to link.
  if (!(links.size === 1 && !links.has(undefined))) {
    commands.push({
      id: 'junctions-link',
      title: 'Link junctions',
      group: 'selection',
      keywords: ['junction', 'link', 'group', 'counterpart', 'continue'],
      run: (inner) => {
        inner.editor.linkJunctions(nodes);
      },
    });
  }
  if (selected.some((node) => node.link)) {
    commands.push({
      id: 'junctions-unlink',
      title: 'Unlink junctions',
      group: 'selection',
      keywords: ['junction', 'unlink', 'detach'],
      run: (inner) => {
        inner.editor.unlinkJunctions(nodes);
      },
    });
  }
  return commands;
}
