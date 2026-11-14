/**
 * Smart Ink's running session: which strokes belong to the drawing still being made, when it is
 * finished, and what happens to it.
 *
 * Every stroke is kept as ink the moment the pen lifts — a drawing is never held anywhere it could be
 * lost. Strokes drawn close together in quick succession (a box drawn as four lines, a shaft and then
 * its head) are one drawing; it is read once the pen has rested for a moment, or as soon as the next
 * stroke starts somewhere else. A confident reading becomes a real shape or connector in one undo step
 * that undo reverses to the strokes; an uncertain one is only offered; nothing recognisable is left
 * exactly as drawn.
 *
 * Plain module state, not React: it lives across renders and is driven by pointer events and timers.
 */
import { pathKey } from '../depth/tree';
import { inkAbsolutePoints, inkOf, inkUnionBounds } from '../document/ink';
import type { DraftInk } from '../document/types';
import type { InkInterpretation } from '../ink/interpret';
import { boxGap, type Box } from '../ink/geometry';
import { motionMs } from '../lib/motion';
import { useEditorStore } from '../store/editorStore';
import { useUiStore } from '../store/uiStore';

/** How long the pen may rest before a drawing counts as finished. */
export const SETTLE_MS = 650;
/** A stroke this close (screen px) to the drawing in progress continues it. */
const CONTINUES_WITHIN = 28;
const RESOLVE_MS = 260;

interface Pending {
  ids: string[];
  box: Box;
  room: string;
  zoom: number;
  timer: ReturnType<typeof setTimeout> | null;
}

let pending: Pending | null = null;
let token = 0;
let recognizer: Promise<typeof import('../ink/smart')> | null = null;

function loadRecognizer() {
  recognizer ??= import('../ink/smart');
  return recognizer;
}

/** Starts loading recognition ahead of the first drawing, so the first reading is not late. */
export function warmSmartInk(): void {
  void loadRecognizer();
}

/** Whether a stroke started at this point (room coordinates) would continue the drawing in progress. */
export function continuesDrawing(point: { x: number; y: number }, zoom: number): boolean {
  if (!pending) return false;
  const reach = Math.max(CONTINUES_WITHIN / zoom, Math.max(pending.box.width, pending.box.height) * 0.25);
  return boxGap(pending.box, { x: point.x, y: point.y, width: 0, height: 0 }) <= reach;
}

/** A stroke has started: the resting timer stops, and a drawing elsewhere is read now. */
export function strokeStarted(point: { x: number; y: number }, zoom: number): void {
  if (!pending) return;
  if (pending.timer) clearTimeout(pending.timer);
  pending.timer = null;
  if (!continuesDrawing(point, zoom)) flushSmartInk();
}

/** A Smart Ink stroke was kept: it joins (or starts) the drawing in progress. */
export function smartStrokeKept(stroke: DraftInk, zoom: number): void {
  const room = pathKey(useEditorStore.getState().path);
  const box = inkUnionBounds([stroke])!;
  if (pending && pending.room !== room) flushSmartInk();
  if (pending) {
    pending.ids.push(stroke.id);
    pending.box = unite(pending.box, box);
    pending.zoom = zoom;
  } else {
    pending = { ids: [stroke.id], box, room, zoom, timer: null };
  }
  if (pending.timer) clearTimeout(pending.timer);
  pending.timer = setTimeout(flushSmartInk, SETTLE_MS);
}

/** Reads the drawing in progress now — the pen rested, or the tool changed. */
export function flushSmartInk(): void {
  const done = pending;
  pending = null;
  if (!done) return;
  if (done.timer) clearTimeout(done.timer);
  void readDrawing(done.ids, done.zoom, { forced: false, room: done.room });
}

/** Forgets the drawing in progress without reading it (its strokes stay ink). */
export function cancelSmartInk(): void {
  if (pending?.timer) clearTimeout(pending.timer);
  pending = null;
}

/**
 * "Convert to shape" on strokes already on the canvas: the same reading, asked for — so a weaker
 * reading is still offered, and the answer always says what happened.
 */
export async function convertStrokes(ids: readonly string[], zoom: number): Promise<void> {
  cancelSmartInk();
  const room = pathKey(useEditorStore.getState().path);
  const outcome = await readDrawing(ids, zoom, { forced: true, room });
  if (outcome === 'none') useUiStore.getState().notify('No shape or connector recognised in that sketch — it stays as drawn.');
}

type Outcome = 'shape' | 'offer' | 'connector' | 'none';

async function readDrawing(ids: readonly string[], zoom: number, options: { forced: boolean; room: string }): Promise<Outcome> {
  const { recognize, interpret } = await loadRecognizer();
  const editor = useEditorStore.getState();
  // Read against the canvas as it is *now*: strokes undone or erased since are gone, and a move to
  // another room means this drawing is not the one on screen any more.
  if (pathKey(editor.path) !== options.room || useUiStore.getState().readOnly) return 'none';
  const wanted = new Set(ids);
  const strokes = inkOf(editor.document).filter((stroke) => wanted.has(stroke.id));
  // A highlighter is emphasis by definition; it never becomes architecture.
  const pens = strokes.filter((stroke) => stroke.tool === 'pen');
  if (pens.length === 0 || pens.length !== strokes.length) return 'none';
  const recognition = recognize(pens.map(inkAbsolutePoints), { scale: zoom });
  const interpretation = interpret(recognition, editor.document.nodes, { scale: zoom, forced: options.forced });
  return act(interpretation, pens, options.forced);
}

function act(interpretation: InkInterpretation, strokes: DraftInk[], forced: boolean): Outcome {
  const editor = useEditorStore.getState();
  const ui = useUiStore.getState();
  const ids = strokes.map((stroke) => stroke.id);
  const room = pathKey(editor.path);
  if (interpretation.kind === 'connector') {
    if (!interpretation.confident && !forced) return 'none';
    const edgeId = editor.inkToConnector(ids, interpretation.source, interpretation.target, interpretation.directed);
    if (!edgeId) return 'none';
    resolve(strokes);
    ui.setInkSuggestion(null);
    return 'connector';
  }
  if (interpretation.kind !== 'shape') return 'none';
  const { box, choices, encloses } = interpretation;
  const base = { strokeIds: ids, strokes, drawn: box, choices, encloses, room };
  if (interpretation.confident || forced) {
    const nodeId = editor.inkToShape(ids, choices[0]!, box, encloses);
    if (!nodeId) return 'none';
    resolve(strokes);
    ui.setSettleNodeIds([nodeId]);
    ui.setInkSuggestion({ ...base, token: (token += 1), mode: 'converted', nodeId, chosen: 0 });
    return 'shape';
  }
  ui.setInkSuggestion({ ...base, token: (token += 1), mode: 'offer', chosen: -1 });
  return 'offer';
}

/** The strokes fade out where the new element fades in — the drawing resolving, not vanishing. */
function resolve(strokes: DraftInk[]): void {
  const duration = motionMs(RESOLVE_MS);
  if (duration <= 0) return;
  const mine = (token += 1);
  useUiStore.getState().setInkResolving({ token: mine, strokes });
  setTimeout(() => {
    if (useUiStore.getState().inkResolving?.token === mine) useUiStore.getState().setInkResolving(null);
  }, duration + 40);
}

/** Applies a choice from the suggestion popover. */
export function chooseSuggestion(index: number): void {
  const ui = useUiStore.getState();
  const suggestion = ui.inkSuggestion;
  if (!suggestion) return;
  const choice = suggestion.choices[index];
  if (!choice) return;
  const editor = useEditorStore.getState();
  if (suggestion.mode === 'converted' && suggestion.nodeId) {
    if (index === suggestion.chosen) return;
    editor.retypeInkShape(suggestion.nodeId, suggestion.strokes, choice, suggestion.drawn, suggestion.encloses);
    ui.setInkSuggestion({ ...suggestion, chosen: index });
    return;
  }
  const nodeId = editor.inkToShape(suggestion.strokeIds, choice, suggestion.drawn, suggestion.encloses);
  if (!nodeId) return;
  resolve(suggestion.strokes);
  ui.setSettleNodeIds([nodeId]);
  ui.setInkSuggestion({ ...suggestion, mode: 'converted', nodeId, chosen: index, token: (token += 1) });
}

/** "Keep as sketch": a converted drawing goes back to its strokes; an offer is simply put away. */
export function keepAsSketch(): void {
  const ui = useUiStore.getState();
  const suggestion = ui.inkSuggestion;
  if (!suggestion) return;
  ui.setInkSuggestion(null);
  if (suggestion.mode === 'converted' && suggestion.nodeId) useEditorStore.getState().revertInkShape(suggestion.nodeId, suggestion.strokes);
}

function unite(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/** Test seam. */
export function __resetInkSession(): void {
  cancelSmartInk();
  recognizer = null;
}
