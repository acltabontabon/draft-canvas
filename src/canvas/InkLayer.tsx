import { memo, useCallback, useEffect, useRef } from 'react';
import { useStoreApi } from '@xyflow/react';
import { inkOf, inkPaintBounds } from '../document/ink';
import type { DraftInk } from '../document/types';
import { inkPaint } from '../render/ink';
import type { ThemeName } from '../render/theme/tokens';
import { useEditorStore } from '../store/editorStore';
import { useUiStore } from '../store/uiStore';
import { ViewportLayer } from './ViewportLayer';
import { liveInkSurface } from './liveInk';


/** A press that moves less than this (screen px) on a stroke is a click, not a drag. */
const DRAG_THRESHOLD = 3;

/**
 * The room's handwritten sketches, drawn over its shapes and connectors in the viewport (so they pan
 * and zoom with the diagram), from the same paint the exports use (`render/ink.ts`).
 *
 * One SVG for every stroke; each stroke is a memoised group that redraws only when that stroke
 * changes. While nothing is in hand (`selectable`), a stroke can be picked, shift-picked, dragged and
 * deleted like any element; with a tool in hand the layer is inert and the Pencil owns the pointer.
 */
export const InkLayer = memo(function InkLayer({ theme, selectable }: { theme: ThemeName; selectable: boolean }) {
  const ink = useEditorStore((state) => state.document.ink);
  const selection = useUiStore((state) => state.inkSelection);
  const resolving = useUiStore((state) => state.inkResolving);
  const storeApi = useStoreApi();
  const layerRef = useRef<SVGSVGElement>(null);
  const selected = selection.length > 0 ? new Set(selection) : null;

  const registerLive = useCallback((path: SVGPathElement | null) => {
    liveInkSurface.path = path;
  }, []);

  useMarqueeSelection(selectable);

  const onStrokeDown = useCallback(
    (event: React.PointerEvent<SVGPathElement>, stroke: DraftInk) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      const ui = useUiStore.getState();
      const editor = useEditorStore.getState();
      const already = ui.inkSelection.includes(stroke.id);
      let ids: readonly string[];
      if (event.shiftKey || event.metaKey || event.ctrlKey) {
        ids = already ? ui.inkSelection.filter((id) => id !== stroke.id) : [...ui.inkSelection, stroke.id];
      } else ids = already ? ui.inkSelection : [stroke.id];
      editor.setSelection({ nodes: [], edges: [] });
      ui.setInkSelection(ids);
      if (!ids.includes(stroke.id)) return;

      // Drag the chosen strokes. Shown by moving their groups directly; the document is written
      // once, on release, as one undo step.
      const layer = layerRef.current;
      const startX = event.clientX;
      const startY = event.clientY;
      const zoom = storeApi.getState().transform[2];
      const moving = new Map<SVGGElement, DraftInk>();
      const byId = new Map(inkOf(editor.document).map((s) => [s.id, s]));
      for (const id of ids) {
        const el = layer?.querySelector<SVGGElement>(`g[data-ink-id="${CSS.escape(id)}"]`);
        const s = byId.get(id);
        if (el && s) moving.set(el, s);
      }
      let dragging = false;
      let dx = 0;
      let dy = 0;
      const onMove = (move: PointerEvent) => {
        const sx = move.clientX - startX;
        const sy = move.clientY - startY;
        if (!dragging && Math.hypot(sx, sy) < DRAG_THRESHOLD) return;
        dragging = true;
        dx = sx / zoom;
        dy = sy / zoom;
        for (const [el, s] of moving) el.setAttribute('transform', `translate(${s.x + dx} ${s.y + dy})`);
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        if (!dragging) return;
        useEditorStore.getState().moveInk([...moving.values()].map((s) => s.id), dx, dy);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    },
    [storeApi],
  );

  const onStrokeContextMenu = useCallback((event: React.MouseEvent<SVGPathElement>, stroke: DraftInk) => {
    event.preventDefault();
    event.stopPropagation();
    const ui = useUiStore.getState();
    if (!ui.inkSelection.includes(stroke.id)) {
      useEditorStore.getState().setSelection({ nodes: [], edges: [] });
      ui.setInkSelection([stroke.id]);
    }
    const [tx, ty, zoom] = storeApi.getState().transform;
    const root = storeApi.getState().domNode?.getBoundingClientRect();
    const flowPosition = { x: (event.clientX - (root?.left ?? 0) - tx) / zoom, y: (event.clientY - (root?.top ?? 0) - ty) / zoom };
    ui.setContextMenu({ target: { kind: 'ink' }, screenPosition: { x: event.clientX, y: event.clientY }, flowPosition });
  }, [storeApi]);

  const strokes = ink ?? [];
  return (
    <ViewportLayer>
      <svg ref={layerRef} className="dc-ink-layer" data-selectable={selectable ? 'true' : undefined} aria-hidden="true" overflow="visible" width="1" height="1">
        {strokes.map((stroke) => (
          <InkStroke
            key={stroke.id}
            stroke={stroke}
            theme={theme}
            selected={selected?.has(stroke.id) ?? false}
            selectable={selectable}
            onDown={onStrokeDown}
            onContextMenu={onStrokeContextMenu}
          />
        ))}
        {resolving && (
          <g key={resolving.token} className="dc-ink-resolving">
            {resolving.strokes.map((stroke) => (
              <InkStroke key={stroke.id} stroke={stroke} theme={theme} selected={false} selectable={false} />
            ))}
          </g>
        )}
        <path ref={registerLive} className="dc-ink-live" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </ViewportLayer>
  );
});

const InkStroke = memo(function InkStroke({
  stroke,
  theme,
  selected,
  selectable,
  onDown,
  onContextMenu,
}: {
  stroke: DraftInk;
  theme: ThemeName;
  selected: boolean;
  selectable: boolean;
  onDown?: (event: React.PointerEvent<SVGPathElement>, stroke: DraftInk) => void;
  onContextMenu?: (event: React.MouseEvent<SVGPathElement>, stroke: DraftInk) => void;
}) {
  const paint = inkPaint(stroke, theme);
  const filled = paint.mode === 'fill';
  // A highlighter is picked by its middle, not its full width: it lies over shapes, and a click on
  // a shape beneath its edge is meant for the shape.
  const hitWidth = stroke.tool === 'highlighter' ? 8 : Math.max(stroke.size, 1) + 10;
  return (
    <g data-ink-id={stroke.id} data-selected={selected ? 'true' : undefined} transform={`translate(${stroke.x} ${stroke.y})`}>
      {selected && (
        <path
          className="dc-ink-halo"
          d={paint.d}
          fill="none"
          strokeWidth={(filled ? 0 : paint.width) + 7}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      <path
        className="dc-ink-stroke"
        d={paint.d}
        fill={filled ? paint.color : 'none'}
        stroke={filled ? 'none' : paint.color}
        strokeWidth={filled ? undefined : paint.width}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={paint.opacity < 1 ? paint.opacity : undefined}
        style={paint.blend ? { mixBlendMode: paint.blend } : undefined}
      />
      {selectable && onDown && (
        <path
          className="dc-ink-hit nopan nodrag"
          d={paint.d}
          fill="none"
          stroke="transparent"
          strokeWidth={hitWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          onPointerDown={(event) => onDown(event, stroke)}
          onContextMenu={onContextMenu ? (event) => onContextMenu(event, stroke) : undefined}
        />
      )}
    </g>
  );
});

/**
 * A marquee drawn on the canvas also picks the strokes wholly inside it, alongside whatever shapes
 * it picks — React Flow's marquee only knows its own nodes, so this watches its rectangle.
 */
function useMarqueeSelection(enabled: boolean): void {
  const storeApi = useStoreApi();
  useEffect(() => {
    if (!enabled) return;
    let last: { x: number; y: number; width: number; height: number } | null = null;
    let transform = storeApi.getState().transform;
    return storeApi.subscribe((state) => {
      const rect = state.userSelectionRect;
      if (rect && state.userSelectionActive) {
        last = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        transform = state.transform;
        return;
      }
      if (!last) return;
      const box = last;
      last = null;
      const [tx, ty, zoom] = transform;
      const flow = { x: (box.x - tx) / zoom, y: (box.y - ty) / zoom, width: box.width / zoom, height: box.height / zoom };
      if (flow.width < 2 && flow.height < 2) return;
      const inside = inkOf(useEditorStore.getState().document)
        .filter((stroke) => {
          const b = inkPaintBounds(stroke);
          return b.x >= flow.x && b.y >= flow.y && b.x + b.width <= flow.x + flow.width && b.y + b.height <= flow.y + flow.height;
        })
        .map((stroke) => stroke.id);
      if (inside.length === 0) return;
      // After React Flow has finished settling its own selection from the same marquee.
      setTimeout(() => useUiStore.getState().setInkSelection(inside), 0);
    });
  }, [enabled, storeApi]);
}
