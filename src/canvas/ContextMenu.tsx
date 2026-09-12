import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ContextMenuEntry } from '../commands/contextMenu';
import type { Command } from '../commands/types';
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

function firstCommandIndex(entries: ContextMenuEntry[]): number {
  const index = entries.findIndex((entry) => entry.type === 'command');
  return index === -1 ? 0 : index;
}

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
 * several rows needs it in a way a short preset list didn't.
 */
export function ContextMenu({ screenPosition, entries, onSelect, onDismiss }: ContextMenuProps) {
  const panel = useRef<HTMLDivElement>(null);

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
  // `aria-activedescendant` below announces which row is "virtually" current.
  useLayoutEffect(() => {
    panel.current?.focus();
  }, []);

  const itemIndices = useMemo(
    () => entries.reduce<number[]>((acc, entry, index) => (entry.type === 'command' ? [...acc, index] : acc), []),
    [entries],
  );
  const [highlight, setHighlight] = useState(() => firstCommandIndex(entries));
  const highlightRef = useRef(highlight);
  highlightRef.current = highlight;
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  // Keep the highlight on a real row if the list changes shape underneath it (e.g. an attachment
  // cap is reached while the menu happens to still be open).
  useEffect(() => {
    if (entries[highlightRef.current]?.type !== 'command') setHighlight(firstCommandIndex(entries));
  }, [entries]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
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
        case 'End': {
          event.preventDefault();
          const edge = event.key === 'Home' ? itemIndices[0] : itemIndices[itemIndices.length - 1];
          if (edge !== undefined) setHighlight(edge);
          return;
        }
        case 'ArrowDown': {
          event.preventDefault();
          const at = itemIndices.indexOf(highlightRef.current);
          const next = itemIndices[Math.min(itemIndices.length - 1, at + 1)];
          if (next !== undefined) setHighlight(next);
          return;
        }
        case 'ArrowUp': {
          event.preventDefault();
          const at = itemIndices.indexOf(highlightRef.current);
          const previous = itemIndices[Math.max(0, at - 1)];
          if (previous !== undefined) setHighlight(previous);
          return;
        }
        case 'Enter':
        case ' ': {
          event.preventDefault();
          const entry = entriesRef.current[highlightRef.current];
          if (entry?.type === 'command') onSelect(entry.command);
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
    // Deferred so the pointerup/click that opened this menu does not itself
    // count as the "click outside" that immediately dismisses it.
    const id = window.setTimeout(() => window.addEventListener('pointerdown', onPointerDown), 0);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown);
      window.clearTimeout(id);
    };
  }, [itemIndices, onDismiss, onSelect]);

  const clearances = { gap: GAP, top: TOP_CLEARANCE, bottom: BOTTOM_CLEARANCE, left: LEFT_CLEARANCE, right: RIGHT_CLEARANCE };
  const anchors = anchorsForRect({ x: screenPosition.x, y: screenPosition.y, width: 0, height: 0 });
  const placement = resolvePlacement('below', anchors, identity, measuredSize, clearances);
  const transform = placementTransform(placement, anchors, measuredSize, clearances, identity, identity);

  const activeId = entries[highlight]?.type === 'command' ? `dc-context-menu-item-${highlight}` : undefined;

  return (
    <div
      ref={panel}
      className="dc-context-menu"
      role="menu"
      aria-label="Context menu"
      aria-activedescendant={activeId}
      tabIndex={-1}
      style={{ transform }}
    >
      {entries.map((entry, index) =>
        entry.type === 'separator' ? (
          <div key={`sep-${index}`} className="dc-context-menu-separator" role="separator" />
        ) : (
          <button
            key={entry.command.id}
            id={`dc-context-menu-item-${index}`}
            type="button"
            role="menuitem"
            className="dc-context-menu-item"
            data-highlighted={index === highlight ? 'true' : undefined}
            data-destructive={entry.command.id === 'delete' ? 'true' : undefined}
            onPointerMove={() => {
              if (highlightRef.current !== index) setHighlight(index);
            }}
            onClick={() => onSelect(entry.command)}
          >
            <span className="dc-context-menu-title">{entry.command.title}</span>
            {entry.command.shortcut && (
              <span className="dc-context-menu-kbd">
                {entry.command.shortcut.split(' ').map((key, i) => (
                  <kbd key={`${key}-${i}`}>{key}</kbd>
                ))}
              </span>
            )}
          </button>
        ),
      )}
    </div>
  );
}
