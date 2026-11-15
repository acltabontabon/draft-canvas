import { useEffect, type RefObject } from 'react';
import { useStoreApi } from '@xyflow/react';
import { inkOf, inkPaintBounds } from '../document/ink';
import type { DraftInk } from '../document/types';
import { buildStroke, type InkSample } from '../ink/capture';
import { segmentDistance, type Pt } from '../ink/geometry';
import { INK_SIZES, inkPaint } from '../render/ink';
import { useEditorStore } from '../store/editorStore';
import { useUiStore, type PencilTool } from '../store/uiStore';
import { useThemeValue } from '../theme/useTheme';
import { cancelSmartInk, flushSmartInk, smartStrokeKept, strokeAbandoned, strokeStarted, warmSmartInk } from './inkSession';
import { liveInkSurface } from './liveInk';

/** The eraser's reach, in screen pixels. */
const ERASER_RADIUS = 9;

/**
 * Once a stylus has touched the canvas, a finger is a hand resting on the screen or a pinch — it
 * pans and zooms rather than drawing. Module state: it holds for the session, across canvases.
 */
let penSeen = false;

/** What the canvas hands to Pointer Events while drawing: nothing it would claim for itself. */
const PASS_THROUGH = '.react-flow__panel, .react-flow__minimap, .react-flow__controls, .dc-popover, .dc-ink-suggestion, button, input, textarea, select, [contenteditable="true"]';

interface Active {
  pointerId: number;
  tool: PencilTool;
  samples: InkSample[];
  pressure: boolean;
  zoom: number;
  /** The pane's page box at the start: the pane does not move while a stroke is drawn. */
  rect: DOMRect;
  /** Eraser only: what it has passed over. */
  erasing: Set<string>;
  frame: number | null;
}

/**
 * Drawing with the Pencil: the canvas's pointer input while a Pencil tool is in hand.
 *
 * Listens in the capture phase on the canvas, ahead of React Flow, and claims only primary presses
 * (a mouse's left button, a pen tip, a finger): the wheel still pans, a pinch still zooms, the middle
 * button still drags the canvas and the right button still opens the context menu. Samples are read
 * from coalesced events so a fast stylus keeps its full resolution, buffered outside React, and drawn
 * once per frame into one live path — a stroke in progress never renders a component.
 */
export function useInkInput(paneRef: RefObject<HTMLDivElement | null>, enabled: boolean): void {
  const storeApi = useStoreApi();
  const theme = useThemeValue();
  const themeName = theme.name;

  useEffect(() => {
    const pane = paneRef.current;
    if (!enabled || !pane) return;
    let active: Active | null = null;
    if (useUiStore.getState().inkPrefs.smart) warmSmartInk();

    const flowPoint = (event: PointerEvent, state: Active): InkSample => {
      const [tx, ty, zoom] = storeApi.getState().transform;
      return {
        x: (event.clientX - state.rect.left - tx) / zoom,
        y: (event.clientY - state.rect.top - ty) / zoom,
        pressure: event.pressure,
      };
    };

    const style = (tool: PencilTool, zoom: number) => {
      const prefs = useUiStore.getState().inkPrefs;
      const kind = tool === 'highlighter' ? 'highlighter' : 'pen';
      const color = kind === 'highlighter' ? prefs.highlighterColor : prefs.penColor;
      const size = INK_SIZES[kind][kind === 'highlighter' ? prefs.highlighterSize : prefs.penSize] / zoom;
      return { tool: kind, color, size } as const;
    };

    const paintLive = () => {
      if (!active) return;
      active.frame = null;
      const path = liveInkSurface.path;
      if (!path) return;
      if (active.tool === 'eraser' || active.samples.length === 0) {
        path.setAttribute('d', '');
        return;
      }
      const origin = active.samples[0]!;
      const points: number[] = [];
      for (const sample of active.samples) points.push(sample.x - origin.x, sample.y - origin.y);
      const kind = style(active.tool, active.zoom);
      const draft: DraftInk = {
        id: 'live',
        ...kind,
        x: origin.x,
        y: origin.y,
        points,
        ...(active.pressure && kind.tool === 'pen' ? { pressure: active.samples.map((s) => Math.round(s.pressure * 100)) } : {}),
      };
      const paint = inkPaint(draft, themeName);
      path.setAttribute('d', paint.d);
      path.setAttribute('transform', `translate(${origin.x} ${origin.y})`);
      path.setAttribute('fill', paint.mode === 'fill' ? paint.color : 'none');
      path.setAttribute('stroke', paint.mode === 'fill' ? 'none' : paint.color);
      path.setAttribute('stroke-width', String(paint.width));
      path.setAttribute('opacity', String(paint.opacity));
      path.style.mixBlendMode = paint.blend ?? '';
    };

    const schedule = () => {
      if (active && active.frame === null) active.frame = requestAnimationFrame(paintLive);
    };

    const clearLive = () => {
      liveInkSurface.path?.setAttribute('d', '');
      for (const el of pane.querySelectorAll('[data-ink-erasing]')) el.removeAttribute('data-ink-erasing');
    };

    const eraseAlong = (from: Pt, to: Pt) => {
      if (!active) return;
      const reach = ERASER_RADIUS / active.zoom;
      for (const stroke of inkOf(useEditorStore.getState().document)) {
        if (active.erasing.has(stroke.id)) continue;
        const box = inkPaintBounds(stroke);
        if (Math.max(from.x, to.x) < box.x - reach || Math.min(from.x, to.x) > box.x + box.width + reach) continue;
        if (Math.max(from.y, to.y) < box.y - reach || Math.min(from.y, to.y) > box.y + box.height + reach) continue;
        const limit = reach + stroke.size / 2;
        const pts = stroke.points;
        let hit = pts.length === 2 && segmentDistance(from, to, { x: stroke.x + pts[0]!, y: stroke.y + pts[1]! }, { x: stroke.x + pts[0]!, y: stroke.y + pts[1]! }) <= limit;
        for (let i = 2; !hit && i + 1 < pts.length; i += 2) {
          const a = { x: stroke.x + pts[i - 2]!, y: stroke.y + pts[i - 1]! };
          const b = { x: stroke.x + pts[i]!, y: stroke.y + pts[i + 1]! };
          if (segmentDistance(from, to, a, b) <= limit) hit = true;
        }
        if (!hit) continue;
        active.erasing.add(stroke.id);
        pane.querySelector(`[data-ink-id="${CSS.escape(stroke.id)}"]`)?.setAttribute('data-ink-erasing', 'true');
      }
    };

    const add = (event: PointerEvent) => {
      if (!active) return;
      const events = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];
      for (const sample of events.length > 0 ? events : [event]) {
        const point = flowPoint(sample, active);
        const previous = active.samples[active.samples.length - 1];
        if (active.tool === 'eraser') eraseAlong(previous ?? point, point);
        active.samples.push(point);
      }
      schedule();
    };

    const finish = (commit: boolean) => {
      const done = active;
      active = null;
      if (!done) return;
      if (done.frame !== null) cancelAnimationFrame(done.frame);
      pane.removeAttribute('data-ink-drawing');
      if (pane.hasPointerCapture?.(done.pointerId)) pane.releasePointerCapture(done.pointerId);
      clearLive();
      // A pen stroke that began (and so stopped the drawing's resting clock) but is not kept.
      if (!commit) {
        if (done.tool === 'pen') strokeAbandoned();
        return;
      }
      const editor = useEditorStore.getState();
      if (done.tool === 'eraser') {
        if (done.erasing.size > 0) {
          cancelSmartInk();
          editor.eraseInk([...done.erasing]);
        }
        return;
      }
      const stroke = buildStroke(done.samples, style(done.tool, done.zoom), { zoom: done.zoom, pressure: done.pressure });
      if (!stroke || !editor.drawInk(stroke)) {
        if (done.tool === 'pen') strokeAbandoned();
        return;
      }
      const ui = useUiStore.getState();
      if (done.tool === 'pen' && ui.inkPrefs.smart) smartStrokeKept(stroke, done.zoom);
    };

    const onPointerDown = (event: PointerEvent) => {
      const tool = useUiStore.getState().pencil;
      if (!tool) return;
      const eraserEnd = event.pointerType === 'pen' && (event.button === 5 || (event.buttons & 32) !== 0);
      if (event.button !== 0 && !eraserEnd) return;
      if (event.target instanceof Element && event.target.closest(PASS_THROUGH)) return;
      if (event.pointerType === 'pen') penSeen = true;
      if (event.pointerType === 'touch') {
        if (penSeen) return;
        // A second finger: this is a pinch, not a stroke. Drop the one begun — it was the pinch's
        // first finger — and let the canvas zoom.
        if (active) {
          finish(false);
          return;
        }
      }
      if (active) return;
      event.preventDefault();
      event.stopPropagation();
      // A press on the canvas puts keyboard focus there, as a click on it always does — held back by
      // `preventDefault`, focus stayed on the toolbar button that picked the Pencil up, and the next
      // key (E for the eraser, Escape) went to that button instead of the canvas.
      if (document.activeElement !== pane) pane.focus({ preventScroll: true });
      const [, , zoom] = storeApi.getState().transform;
      const rect = (storeApi.getState().domNode ?? pane).getBoundingClientRect();
      active = {
        pointerId: event.pointerId,
        tool: eraserEnd ? 'eraser' : tool,
        samples: [],
        pressure: event.pointerType === 'pen',
        zoom,
        rect,
        erasing: new Set(),
        frame: null,
      };
      pane.setAttribute('data-ink-drawing', active.tool);
      try {
        pane.setPointerCapture(event.pointerId);
      } catch {
        // A pointer the browser no longer tracks: draw without capture.
      }
      const ui = useUiStore.getState();
      // Drawing on is accepting: the last drawing's offer is put away, and so is a selection.
      if (ui.inkSuggestion) ui.setInkSuggestion(null);
      if (ui.inkSelection.length > 0) ui.setInkSelection([]);
      const first = flowPoint(event, active);
      if (active.tool === 'pen') strokeStarted(first, zoom);
      add(event);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!active || event.pointerId !== active.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      add(event);
    };

    const onPointerUp = (event: PointerEvent) => {
      if (!active || event.pointerId !== active.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      add(event);
      finish(true);
    };

    const onPointerCancel = (event: PointerEvent) => {
      if (!active || event.pointerId !== active.pointerId) return;
      // The browser took the pointer (a system gesture): keep what was drawn rather than lose it.
      finish(active.tool !== 'eraser' && active.samples.length > 1);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !active) return;
      // Escape mid-stroke takes back just that stroke.
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    };

    // A click that ends a stroke must not also reach the canvas as one.
    const onClick = (event: MouseEvent) => {
      if (!useUiStore.getState().pencil) return;
      if (event.target instanceof Element && event.target.closest(PASS_THROUGH)) return;
      event.stopPropagation();
    };

    pane.addEventListener('pointerdown', onPointerDown, true);
    pane.addEventListener('pointermove', onPointerMove, true);
    pane.addEventListener('pointerup', onPointerUp, true);
    pane.addEventListener('pointercancel', onPointerCancel, true);
    pane.addEventListener('click', onClick, true);
    pane.addEventListener('dblclick', onClick, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      pane.removeEventListener('pointerdown', onPointerDown, true);
      pane.removeEventListener('pointermove', onPointerMove, true);
      pane.removeEventListener('pointerup', onPointerUp, true);
      pane.removeEventListener('pointercancel', onPointerCancel, true);
      pane.removeEventListener('click', onClick, true);
      pane.removeEventListener('dblclick', onClick, true);
      window.removeEventListener('keydown', onKeyDown, true);
      // Put down mid-stroke (a key switched tools): what was drawn so far is kept, never dropped.
      finish(active !== null && active.tool !== 'eraser' && active.samples.length > 1);
      flushSmartInk();
    };
  }, [enabled, paneRef, storeApi, themeName]);
}
