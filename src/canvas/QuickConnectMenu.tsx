import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useUiStore } from '../store/uiStore';
import { QUICK_CONNECT_PRESETS, type Preset } from './presets';
import {
  anchorsForRect,
  placementTransform,
  resolvePlacement,
  type PlacementPoint,
} from './popoverPlacement';

export interface QuickConnectMenuProps {
  /** Screen coordinates — fixed for the life of the menu. */
  screenPosition: { x: number; y: number };
  onSelect: (preset: Preset) => void;
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
 * The tiny type picker offered whenever Draft Canvas needs the user to
 * choose a type rather than guess one: a connection dragged onto empty
 * canvas, or a double-click on empty canvas with no tool armed — see
 * `QuickConnectState` in `store/uiStore.ts`. Deliberately a plain list
 * driven by `QUICK_CONNECT_PRESETS` — not bespoke JSX per option — so a
 * later pass can add arrow-key navigation or promote a recently-used type
 * without restructuring this component.
 *
 * Clamped to the viewport the same way the flow-anchored popovers are (`popoverPlacement.ts`),
 * just with an identity flow-to-screen conversion since this anchor is screen-fixed to begin
 * with. No placement-stability state is needed here, unlike those — `screenPosition` never moves
 * during this menu's lifetime, so there's nothing to flip against.
 */
export function QuickConnectMenu({ screenPosition, onSelect, onDismiss }: QuickConnectMenuProps) {
  const panel = useRef<HTMLDivElement>(null);
  const flowPanelOpen = useUiStore((state) => state.flowPanelOpen);

  const [measuredSize, setMeasuredSize] = useState({ width: 0, height: 0 });
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const rect = panel.current?.getBoundingClientRect();
    if (!rect) return;
    if (rect.width > 0 && rect.height > 0 && (rect.width !== measuredSize.width || rect.height !== measuredSize.height)) {
      setMeasuredSize({ width: rect.width, height: rect.height });
    }
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onDismiss();
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
  }, [onDismiss]);

  const clearances = {
    gap: GAP,
    top: TOP_CLEARANCE,
    bottom: BOTTOM_CLEARANCE,
    left: LEFT_CLEARANCE,
    right: flowPanelOpen ? RIGHT_CLEARANCE_WITH_FLOW_PANEL : LEFT_CLEARANCE,
  };
  const anchors = anchorsForRect({ x: screenPosition.x, y: screenPosition.y, width: 0, height: 0 });
  const placement = resolvePlacement('below', anchors, identity, measuredSize, clearances);
  const transform = placementTransform(placement, anchors, measuredSize, clearances, identity, identity);

  return (
    <div
      ref={panel}
      className="dc-quick-connect"
      role="menu"
      aria-label="Add element"
      style={{ transform }}
    >
      {QUICK_CONNECT_PRESETS.map((preset) => (
        <button
          key={preset.id}
          type="button"
          role="menuitem"
          className="dc-quick-connect-item"
          onClick={() => onSelect(preset)}
        >
          {preset.label}
        </button>
      ))}
    </div>
  );
}
