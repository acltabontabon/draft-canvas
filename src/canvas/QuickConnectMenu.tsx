import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useUiStore } from '../store/uiStore';
import {
  anchorsForRect,
  placementTransform,
  resolvePlacement,
  type PlacementPoint,
} from './popoverPlacement';
import type { QuickConnectItem } from './quickConnectItems';
import { ShapePreview } from './ShapePreview';

export interface QuickConnectMenuProps {
  /** Screen coordinates — fixed for the life of the menu. */
  screenPosition: { x: number; y: number };
  /** The screen-space box the menu should sit clear of — the ghost previewing the highlighted row
   *  is centred on the drop point, and a menu anchored to that point would cover half of it. Fixed
   *  for the life of the menu like `screenPosition`; absent for a picker with nothing to preview. */
  anchorRect?: { x: number; y: number; width: number; height: number };
  /** Rows, best first — see `quickConnectItems`. */
  items: QuickConnectItem[];
  onSelect: (item: QuickConnectItem) => void;
  /** The row the keyboard/pointer is on, so the caller can preview it. Called with the first row
   *  on open, then on every change; never with an out-of-range index. */
  onHighlight?: (item: QuickConnectItem) => void;
  onDismiss: () => void;
}

/** No conversion needed: `screenPosition` is already screen space, unlike the flow-space anchors
 *  the other popovers place from — `popoverPlacement.ts`'s math only cares that some space maps
 *  to screen space, so a no-op conversion is all a screen-fixed anchor needs. */
const identity = (point: PlacementPoint) => point;

/** Same basis as `ElementInspectorPopover`'s `TOP_CLEARANCE`/`EdgeInspectorPopover`'s
 *  `TOOLBAR_CLEARANCE` (`--dc-bar-height: 46px` + margin), kept as its own independent constant
 *  for the same reason those two are — this file can never regress theirs and vice versa. */
const TOP_CLEARANCE = 56;
const BOTTOM_CLEARANCE = 44;
const LEFT_CLEARANCE = 12;
const RIGHT_CLEARANCE_WITH_FLOW_PANEL = 312;
const GAP = 6;

/**
 * The tiny type picker offered whenever Draft Canvas needs the user to choose a type rather than
 * guess one: a connection dragged onto empty canvas, or a double-click on empty canvas with no
 * tool armed — see `QuickConnectState` in `store/uiStore.ts`.
 *
 * Its rows are data (`quickConnectItems`), best first: when the source node has an obvious next
 * move, that move leads and is already highlighted, so Enter (or Tab) takes it and the ghost on
 * the canvas shows what that means before anything is created. Arrows move the highlight — and
 * the ghost with it — through every row, suggested or not. A choice, still, never a guess; the
 * suggestion just goes first.
 *
 * Clamped to the viewport the same way the flow-anchored popovers are (`popoverPlacement.ts`),
 * just with an identity flow-to-screen conversion since this anchor is screen-fixed to begin
 * with. No placement-stability state is needed here, unlike those — `screenPosition` never moves
 * during this menu's lifetime, so there's nothing to flip against.
 */
export function QuickConnectMenu({
  screenPosition,
  anchorRect,
  items,
  onSelect,
  onHighlight,
  onDismiss,
}: QuickConnectMenuProps) {
  const panel = useRef<HTMLDivElement>(null);
  const flowPanelOpen = useUiStore((state) => state.flowPanelOpen);
  const [highlighted, setHighlighted] = useState(0);

  const [measuredSize, setMeasuredSize] = useState({ width: 0, height: 0 });
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const rect = panel.current?.getBoundingClientRect();
    if (!rect) return;
    if (rect.width > 0 && rect.height > 0 && (rect.width !== measuredSize.width || rect.height !== measuredSize.height)) {
      setMeasuredSize({ width: rect.width, height: rect.height });
    }
  });

  // The highlighted row is what the canvas previews; report it whenever it (or the row set) changes.
  const current = items[Math.min(highlighted, items.length - 1)];
  useEffect(() => {
    if (current) onHighlight?.(current);
  }, [current, onHighlight]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      switch (event.key) {
        case 'Escape':
          event.stopPropagation();
          onDismiss();
          return;
        case 'ArrowDown':
        case 'ArrowUp': {
          event.preventDefault();
          event.stopPropagation();
          const delta = event.key === 'ArrowDown' ? 1 : -1;
          setHighlighted((index) => (index + delta + items.length) % items.length);
          return;
        }
        case 'Enter':
        case 'Tab': {
          event.preventDefault();
          event.stopPropagation();
          const item = items[Math.min(highlighted, items.length - 1)];
          if (item) onSelect(item);
          return;
        }
        default:
          return;
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (panel.current && !panel.current.contains(event.target as Node)) onDismiss();
    };
    window.addEventListener('keydown', onKeyDown, true);
    // Deferred so the pointerup that released the connection drag does not
    // itself count as the "click outside" that dismisses the menu.
    const id = window.setTimeout(() => window.addEventListener('pointerdown', onPointerDown), 0);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown);
      window.clearTimeout(id);
    };
  }, [onDismiss, onSelect, items, highlighted]);

  const clearances = {
    gap: GAP,
    top: TOP_CLEARANCE,
    bottom: BOTTOM_CLEARANCE,
    left: LEFT_CLEARANCE,
    right: flowPanelOpen ? RIGHT_CLEARANCE_WITH_FLOW_PANEL : LEFT_CLEARANCE,
  };
  const anchors = anchorsForRect(anchorRect ?? { x: screenPosition.x, y: screenPosition.y, width: 0, height: 0 });
  const placement = resolvePlacement('below', anchors, identity, measuredSize, clearances);
  const transform = placementTransform(placement, anchors, measuredSize, clearances, identity, identity);

  const firstPreset = items.findIndex((item) => item.kind === 'preset');
  const hasSuggestions = firstPreset > 0;

  return (
    <div
      ref={panel}
      className="dc-quick-connect"
      role="menu"
      aria-label="Add element"
      style={{ transform }}
    >
      {items.map((item, index) => (
        <div key={item.id} className="dc-quick-connect-row">
          {hasSuggestions && index === firstPreset && <div className="dc-quick-connect-separator" role="separator" />}
          <button
            type="button"
            role="menuitem"
            className="dc-quick-connect-item"
            data-highlighted={index === highlighted ? 'true' : undefined}
            data-suggested={item.kind === 'continuation' ? 'true' : undefined}
            onPointerEnter={() => setHighlighted(index)}
            onClick={() => onSelect(item)}
          >
            <ShapePreview node={item.node} width={30} height={20} />
            <span>{item.label}</span>
          </button>
        </div>
      ))}
    </div>
  );
}
