import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useToolbarHeight } from './useToolbarHeight';
import { menuItemsOf, type AlignIcon, type ContextMenuEntry } from '../commands/contextMenu';
import { warmCopyExports } from '../commands/registry';
import type { Command } from '../commands/types';
import { Icon, type IconName } from '../ui/common/Icon';
import { isEditableTarget } from '../lib/isEditableTarget';
import { plainShortcut } from '../lib/platform';
import {
  anchorsForRect,
  placementTransform,
  resolvePlacement,
  type PlacementPoint,
} from './popoverPlacement';

export interface ContextMenuProps {
  /** Screen coordinates — fixed for the life of the menu, same reasoning as `QuickConnectMenu`. */
  screenPosition: { x: number; y: number };
  entries: ContextMenuEntry[];
  /** Opened from the keyboard: start on the first row. A right-click starts with none highlighted. */
  viaKeyboard?: boolean;
  onSelect: (command: Command) => void;
  onDismiss: () => void;
}

/** No conversion needed — see `QuickConnectMenu.tsx`'s identical comment: `screenPosition` is
 *  already screen space, so `popoverPlacement.ts`'s math just needs a space that maps to itself. */
const identity = (point: PlacementPoint) => point;

/** Its own independently-declared clearances, per this codebase's house style (see
 *  `popoverPlacement.ts`'s own doc comment) — never shared with `QuickConnectMenu`'s or any other
 *  popover's constants, so tuning one can never silently regress another. */
const TOP_CLEARANCE = 56;
const BOTTOM_CLEARANCE = 44;
const LEFT_CLEARANCE = 12;
const RIGHT_CLEARANCE = 12;
const GAP = 2;

const ALIGN_GLYPHS: Record<AlignIcon, IconName> = {
  'align-left': 'shapesLeft',
  'align-center-x': 'shapesCenterX',
  'align-right': 'shapesRight',
  'align-top': 'shapesTop',
  'align-center-y': 'shapesCenterY',
  'align-bottom': 'shapesBottom',
  'distribute-x': 'distributeX',
  'distribute-y': 'distributeY',
};

/**
 * The right-click context menu's rendering/dismissal shell — deliberately free of any domain
 * knowledge (node types, selection shape, what a command does). The caller (`EditorScreen.tsx`)
 * decides *what* to show via `contextMenuCommandsFor` and *what happens* on selection; this
 * component only knows how to position itself at a point, keep itself on-screen, navigate with the
 * keyboard, and get out of the way on Escape/outside-click/an executed command.
 *
 * Structurally modeled on `QuickConnectMenu.tsx` (same point-anchored placement recipe, same
 * capture-phase Escape, same one-tick-deferred outside-pointerdown dismissal so the opening
 * right-click doesn't immediately close it) with keyboard navigation added on top, since a menu with
 * several rows needs it in a way a short preset list didn't. Arrow keys walk every runnable item in
 * order — a grid's cells and an icon row's buttons included — and Left/Right also move along a row.
 */
export function ContextMenu({ screenPosition, entries, viaKeyboard = false, onSelect, onDismiss }: ContextMenuProps) {
  const panel = useRef<HTMLDivElement>(null);
  // Its Copy rows must be able to start a clipboard write inside the click — see `warmCopyExports`.
  useEffect(warmCopyExports, []);

  const [measuredSize, setMeasuredSize] = useState({ width: 0, height: 0 });
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const rect = panel.current?.getBoundingClientRect();
    if (!rect) return;
    if (rect.width > 0 && rect.height > 0 && (rect.width !== measuredSize.width || rect.height !== measuredSize.height)) {
      setMeasuredSize({ width: rect.width, height: rect.height });
    }
  });

  // Real focus lands on the menu itself (there's no input to anchor it to, unlike the palette) —
  // `aria-activedescendant` below announces which row is "virtually" current. Read during the first
  // render, before that focus moves: closing hands focus back (Shift+F10 then Escape would otherwise
  // leave it on the page body, and the next Tab starts from the top) — unless the chosen command
  // already put it somewhere of its own.
  const [returnFocusTo] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  useLayoutEffect(() => {
    const menu = panel.current;
    menu?.focus();
    return () => {
      const active = document.activeElement;
      const unclaimed = !active || active === document.body || (menu?.contains(active) ?? false);
      if (unclaimed && returnFocusTo?.isConnected) returnFocusTo.focus({ preventScroll: true });
    };
  }, [returnFocusTo]);

  const items = useMemo(() => menuItemsOf(entries), [entries]);
  /** Which runnable items sit in a grid or icon row, where Left/Right move between neighbours. */
  const inRow = useMemo(() => {
    const indices = new Set<number>();
    let index = 0;
    for (const entry of entries) {
      if (entry.type === 'command') index += 1;
      else if (entry.type === 'grid' || entry.type === 'icons') for (const _ of entry.items) indices.add(index++);
    }
    return indices;
  }, [entries]);

  // -1: nothing highlighted yet. A pointer-opened menu waits for the pointer or an arrow key.
  const [highlight, setHighlight] = useState(() => (viaKeyboard && items.length > 0 ? 0 : -1));
  // A row answers only a press that began inside the menu. A long-press opens the menu under the
  // finger, and on a short screen it can land over the point being held — the click the lift
  // produces must not pick whichever row ended up there.
  const pressedInside = useRef(false);
  const highlightRef = useRef(highlight);
  highlightRef.current = highlight;
  const itemsRef = useRef(items);
  itemsRef.current = items;

  // Keep the highlight on a real item if the list changes shape underneath it (e.g. an attachment
  // cap is reached while the menu happens to still be open).
  useEffect(() => {
    if (highlightRef.current >= items.length) setHighlight(items.length > 0 ? items.length - 1 : -1);
  }, [items]);

  useEffect(() => {
    const last = items.length - 1;
    const onKeyDown = (event: KeyboardEvent) => {
      const at = highlightRef.current;
      // While it's open the menu owns bare keys, as the toolbar's More menu does: an arrow would
      // otherwise also nudge the selection behind it, a letter drop a shape, Backspace delete it.
      // The editor already stands down for its own right-click menu; a menu opened from a popover's
      // ⋯ has no such flag to check. ⌘ chords still reach the editor.
      if (!event.metaKey && !event.ctrlKey && !isEditableTarget(event.target)) event.stopPropagation();
      switch (event.key) {
        case 'Escape':
          event.stopPropagation();
          onDismiss();
          return;
        // Tab would move focus out while the menu stayed open over whatever it landed on — a menu
        // is a transient choice, so leaving it by keyboard closes it, as a click-away does.
        case 'Tab':
          event.preventDefault();
          event.stopPropagation();
          onDismiss();
          return;
        case 'Home':
        case 'End':
          event.preventDefault();
          if (last >= 0) setHighlight(event.key === 'Home' ? 0 : last);
          return;
        case 'ArrowDown':
          event.preventDefault();
          if (last >= 0) setHighlight(at < 0 ? 0 : Math.min(last, at + 1));
          return;
        case 'ArrowUp':
          event.preventDefault();
          if (last >= 0) setHighlight(at < 0 ? last : Math.max(0, at - 1));
          return;
        case 'ArrowRight':
        case 'ArrowLeft': {
          if (!inRow.has(at)) return;
          event.preventDefault();
          const next = at + (event.key === 'ArrowRight' ? 1 : -1);
          if (inRow.has(next)) setHighlight(next);
          return;
        }
        case 'Enter':
        case ' ': {
          event.preventDefault();
          // Choosing clears the menu state straight away, so by the time this key bubbles to the
          // editor its "a menu is open" guard is gone and Enter would also open the label editor.
          event.stopPropagation();
          const item = itemsRef.current[at];
          if (item) onSelect(item.command);
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
    // A menu pinned to a screen point means nothing once the page under it resizes or the window
    // loses focus (panning the canvas closes it from `Canvas.tsx`'s `onMoveStart`).
    window.addEventListener('resize', onDismiss);
    window.addEventListener('blur', onDismiss);
    // Deferred so the pointerup/click that opened this menu does not itself
    // count as the "click outside" that immediately dismisses it.
    const id = window.setTimeout(() => window.addEventListener('pointerdown', onPointerDown), 0);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', onDismiss);
      window.removeEventListener('blur', onDismiss);
      window.removeEventListener('pointerdown', onPointerDown);
      window.clearTimeout(id);
    };
  }, [items, inRow, onDismiss, onSelect]);

  // The toolbar wraps to two rows on a narrow window, and isn't there at all while presenting — so
  // its real height, with `TOP_CLEARANCE` only until it's been measured (same as the inspectors).
  const measuredToolbarHeight = useToolbarHeight(true);
  const toolbarClearance = measuredToolbarHeight !== undefined ? measuredToolbarHeight + 10 : TOP_CLEARANCE;
  const clearances = { gap: GAP, top: toolbarClearance, bottom: BOTTOM_CLEARANCE, left: LEFT_CLEARANCE, right: RIGHT_CLEARANCE };
  const anchors = anchorsForRect({ x: screenPosition.x, y: screenPosition.y, width: 0, height: 0 });
  const placement = resolvePlacement('below', anchors, identity, measuredSize, clearances);
  const transform = placementTransform(placement, anchors, measuredSize, clearances, identity, identity);

  const activeId = highlight >= 0 && highlight < items.length ? `dc-context-menu-item-${highlight}` : undefined;
  // A long menu can be taller than a short window. Capped to the room between the toolbar and the
  // bottom clearance it scrolls instead, so its last rows — Delete among them — stay reachable; no
  // resize can invalidate this, since a resize closes the menu.
  const maxHeight = Math.max(0, window.innerHeight - toolbarClearance - BOTTOM_CLEARANCE);

  // The keyboard can move the highlight onto a row scrolled out of view.
  useEffect(() => {
    if (!activeId) return;
    panel.current?.querySelector(`#${activeId}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeId]);

  const header = entries.find((entry) => entry.type === 'header');
  let itemIndex = 0;
  const itemProps = (command: Command) => {
    const index = itemIndex++;
    return {
      id: `dc-context-menu-item-${index}`,
      type: 'button' as const,
      role: 'menuitem',
      'aria-keyshortcuts': command.shortcut,
      'data-highlighted': index === highlight ? 'true' : undefined,
      onPointerMove: () => {
        if (highlightRef.current !== index) setHighlight(index);
      },
      onClick: () => {
        if (pressedInside.current) onSelect(command);
      },
    };
  };

  return (
    <div
      ref={panel}
      className="dc-context-menu"
      role="menu"
      aria-label={header ? `${header.title} options` : 'Context menu'}
      aria-activedescendant={activeId}
      tabIndex={-1}
      style={{ transform, maxHeight }}
      onPointerDown={() => {
        pressedInside.current = true;
      }}
      onPointerLeave={() => setHighlight(-1)}
    >
      {entries.map((entry, entryIndex) => {
        switch (entry.type) {
          case 'separator':
            return <div key={`sep-${entryIndex}`} className="dc-context-menu-separator" role="separator" />;
          case 'header':
            return (
              <div key="header" className="dc-context-menu-header" role="presentation">
                <span className="dc-context-menu-header-title">{entry.title}</span>
                {entry.caption && <span className="dc-context-menu-header-caption"> · {entry.caption}</span>}
              </div>
            );
          case 'grid':
            return (
              <div key={`grid-${entryIndex}`} role="group" aria-label={entry.label}>
                <div className="dc-context-menu-label" aria-hidden="true">
                  {entry.label}
                </div>
                <div className="dc-context-menu-grid">
                  {entry.items.map((item) => (
                    <button key={item.command.id} {...itemProps(item.command)} className="dc-context-menu-item">
                      <span className="dc-context-menu-title">{item.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            );
          case 'icons':
            return (
              <div key={`icons-${entryIndex}`} className="dc-context-menu-icons" role="group" aria-label={entry.label}>
                {entry.items.map((item) => (
                  <button key={item.command.id} {...itemProps(item.command)} className="dc-context-menu-icon" aria-label={item.label} title={item.label}>
                    <Icon name={ALIGN_GLYPHS[item.icon]} />
                  </button>
                ))}
              </div>
            );
          case 'command':
            return (
              <button
                key={entry.command.id}
                {...itemProps(entry.command)}
                className="dc-context-menu-item"
                data-destructive={entry.command.id === 'delete' ? 'true' : undefined}
              >
                <span className="dc-context-menu-title">{entry.label}</span>
                {entry.command.shortcut && (
                  <span className="dc-context-menu-shortcut" aria-hidden="true">
                    {plainShortcut(entry.command.shortcut)}
                  </span>
                )}
              </button>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}
