import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  anchorsForRect,
  placementTransform,
  resolvePlacement,
  type PlacementPoint,
} from '../../../canvas/popoverPlacement';
import { Icon } from '../../common/Icon';

export interface ToolbarMenuItem {
  id: string;
  label: string;
  shortcut?: string;
  /** Present ⇒ the row is a toggle and renders its state as a check. */
  checked?: boolean;
  /** A badge the collapsed trigger is also showing — repeated on the row so opening the menu
   *  says *which* item was asking for attention. */
  dot?: 'new' | 'update';
  onSelect: () => void;
}

interface ToolbarMenuProps {
  /** The trigger's own rect, so the menu hangs off the button rather than off a bare point. */
  anchorRect: DOMRect;
  /** The trigger itself. Pointer events on it are not "outside": it owns the open/closed toggle,
   *  and dismissing here first would let its own click immediately re-open the menu. */
  trigger: HTMLElement | null;
  items: ToolbarMenuItem[];
  onDismiss: () => void;
}

/** `popoverPlacement`'s math only needs a space that maps to itself — the anchor is already in
 *  screen coordinates. Same identity trick `ContextMenu` and `QuickConnectMenu` use. */
const identity = (point: PlacementPoint) => point;

/** Its own clearances, per `popoverPlacement.ts`'s house rule that no two callers share constants
 *  — the toolbar sits at the top of the window, so this one always wants to open downward. */
const TOP_CLEARANCE = 8;
const BOTTOM_CLEARANCE = 12;
const LEFT_CLEARANCE = 8;
const RIGHT_CLEARANCE = 8;
const GAP = 6;

/**
 * The toolbar's overflow menu — Canvas settings, Learn, Keyboard shortcuts, About.
 *
 * Structurally modelled on `canvas/ContextMenu.tsx` rather than extracted into a shared generic
 * Menu, following the precedent `MoveToProjectMenu` set: the two menus want the same keyboard and
 * dismissal behaviour but different rows (this one has toggle checks and badge dots, which a
 * canvas right-click never needs), and a shared abstraction would have to grow both.
 */
export function ToolbarMenu({ anchorRect, trigger, items, onDismiss }: ToolbarMenuProps) {
  const panel = useRef<HTMLDivElement>(null);
  const [measuredSize, setMeasuredSize] = useState({ width: 0, height: 0 });

  // oxlint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const rect = panel.current?.getBoundingClientRect();
    if (!rect) return;
    if (
      rect.width > 0 &&
      rect.height > 0 &&
      (rect.width !== measuredSize.width || rect.height !== measuredSize.height)
    ) {
      setMeasuredSize({ width: rect.width, height: rect.height });
    }
  });

  useLayoutEffect(() => {
    panel.current?.focus();
  }, []);

  const [highlight, setHighlight] = useState(0);
  const highlightRef = useRef(highlight);
  highlightRef.current = highlight;
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      switch (event.key) {
        case 'Escape':
          event.stopPropagation();
          onDismiss();
          return;
        // Same as `ContextMenu`: leaving by keyboard closes the menu rather than stranding it open
        // over wherever focus landed.
        case 'Tab':
          event.preventDefault();
          event.stopPropagation();
          onDismiss();
          return;
        case 'ArrowDown':
          event.preventDefault();
          setHighlight((at) => Math.min(itemsRef.current.length - 1, at + 1));
          return;
        case 'ArrowUp':
          event.preventDefault();
          setHighlight((at) => Math.max(0, at - 1));
          return;
        case 'Home':
          event.preventDefault();
          setHighlight(0);
          return;
        case 'End':
          event.preventDefault();
          setHighlight(itemsRef.current.length - 1);
          return;
        case 'Enter':
        case ' ': {
          // Only while the menu has focus — never swallow a space typed into a field elsewhere.
          if (!panel.current?.contains(document.activeElement)) return;
          event.preventDefault();
          itemsRef.current[highlightRef.current]?.onSelect();
          return;
        }
        default:
          return;
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (trigger?.contains(target)) return;
      if (panel.current && !panel.current.contains(target)) onDismiss();
    };
    window.addEventListener('keydown', onKeyDown, true);
    // Deferred so the click that opened this menu isn't itself the outside-click that closes it.
    const id = window.setTimeout(() => window.addEventListener('pointerdown', onPointerDown), 0);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown);
      window.clearTimeout(id);
    };
  }, [onDismiss, trigger]);

  const clearances = {
    gap: GAP,
    top: TOP_CLEARANCE,
    bottom: BOTTOM_CLEARANCE,
    left: LEFT_CLEARANCE,
    right: RIGHT_CLEARANCE,
  };
  const anchors = anchorsForRect({
    x: anchorRect.x,
    y: anchorRect.y,
    width: anchorRect.width,
    height: anchorRect.height,
  });
  const placement = resolvePlacement('below', anchors, identity, measuredSize, clearances);
  const transform = placementTransform(placement, anchors, measuredSize, clearances, identity, identity);

  return (
    <div
      ref={panel}
      className="dc-context-menu dc-toolbar-menu"
      role="menu"
      aria-label="More"
      aria-activedescendant={`dc-toolbar-menu-item-${highlight}`}
      tabIndex={-1}
      style={{ transform }}
    >
      {items.map((item, index) => (
        <button
          key={item.id}
          id={`dc-toolbar-menu-item-${index}`}
          type="button"
          role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
          aria-checked={item.checked}
          // The visible caps are decoration for the name's purposes — announcing "Keyboard
          // shortcuts question mark" helps nobody. `aria-keyshortcuts` is what conveys this.
          aria-keyshortcuts={item.shortcut}
          className="dc-context-menu-item dc-toolbar-menu-item"
          data-highlighted={index === highlight ? 'true' : undefined}
          onPointerMove={() => {
            if (highlightRef.current !== index) setHighlight(index);
          }}
          onClick={item.onSelect}
        >
          <span className="dc-toolbar-menu-check" aria-hidden="true">
            {item.checked && <Icon name="check" size={13} />}
          </span>
          <span className="dc-context-menu-title">{item.label}</span>
          {item.dot && (
            <span
              className={item.dot === 'update' ? 'dc-update-dot' : 'dc-new-dot'}
              data-inline="true"
              aria-hidden="true"
            />
          )}
          {item.shortcut && (
            <span className="dc-context-menu-kbd" aria-hidden="true">
              {item.shortcut.split(' ').map((key, i) => (
                <kbd key={`${key}-${i}`}>{key}</kbd>
              ))}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
