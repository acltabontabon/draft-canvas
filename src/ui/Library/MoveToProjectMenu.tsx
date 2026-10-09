import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Project } from '../../document/types';
import { Icon } from '../common/Icon';
import { useFocusReturn } from '../common/useFocusReturn';

interface MoveToProjectMenuProps {
  currentProjectId: string | undefined;
  projects: Project[];
  onMove: (projectId: string | undefined) => void;
  onClose: () => void;
}

/**
 * A small popover listing Unorganized + every project, opened from a canvas
 * row's folder icon. Modeled on `ContextMenu.tsx`'s menu — the closest
 * existing menu pattern, including its arrow-key highlight and focus
 * handling — rather than introducing a new generic Menu system for this one
 * use.
 */
export function MoveToProjectMenu({ currentProjectId, projects, onMove, onClose }: MoveToProjectMenuProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const sortedProjects = useMemo(() => [...projects].sort((a, b) => a.name.localeCompare(b.name)), [projects]);

  // Unorganized, then every project — the same order rows render in below, so a row's index here
  // is also its `dc-move-menu-item-<index>` id and its position for Arrow/Home/End.
  const ids = useMemo(() => [undefined, ...sortedProjects.map((project) => project.id as string | undefined)], [sortedProjects]);
  const [highlight, setHighlight] = useState(() => Math.max(0, ids.indexOf(currentProjectId)));
  const highlightRef = useRef(highlight);
  useEffect(() => {
    highlightRef.current = highlight;
  }, [highlight]);

  // Real focus lands on the menu itself, same as `ContextMenu` — there's no input to anchor it to.
  useLayoutEffect(() => {
    rootRef.current?.focus();
  }, []);
  // Closing hands focus back to whatever had it before the menu opened (the trigger button) —
  // shared with `Modal`/`CommandPalette` so every dismissible surface in the app agrees on this.
  const returnFocusTo = useFocusReturn(true);

  useLayoutEffect(() => {
    rootRef.current?.querySelector<HTMLElement>('[data-highlighted="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [highlight]);

  useEffect(() => {
    const select = (index: number) => {
      onMove(ids[index]);
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      switch (event.key) {
        case 'Escape':
          event.stopPropagation();
          onClose();
          return;
        // Same as `ContextMenu` and the toolbar menu: leaving by keyboard closes the menu. Left open,
        // Tab walked focus on to another control while this window-level listener kept taking its
        // Enter, Space and arrows.
        case 'Tab':
          event.preventDefault();
          event.stopPropagation();
          onClose();
          return;
        case 'Home':
        case 'End':
          event.preventDefault();
          setHighlight(event.key === 'Home' ? 0 : ids.length - 1);
          return;
        case 'ArrowDown':
          event.preventDefault();
          setHighlight(Math.min(ids.length - 1, highlightRef.current + 1));
          return;
        case 'ArrowUp':
          event.preventDefault();
          setHighlight(Math.max(0, highlightRef.current - 1));
          return;
        case 'Enter':
        case ' ':
          event.preventDefault();
          select(highlightRef.current);
          return;
        default:
          return;
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      const target = event.target as Node;
      // The anchor includes the folder trigger, which owns its own toggle. Dismissing on its
      // pointerdown would make its later click open the menu again.
      if (!root || root.parentElement?.contains(target)) return;
      // An outside click is moving focus somewhere else; closing must not steal it back.
      returnFocusTo.current = null;
      onClose();
    };
    window.addEventListener('keydown', onKeyDown, true);
    // Deferred one tick so the pointerdown that opened this menu doesn't also close it.
    const id = window.setTimeout(() => window.addEventListener('pointerdown', onPointerDown), 0);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown);
      window.clearTimeout(id);
    };
  }, [ids, onClose, onMove, returnFocusTo]);

  const row = (index: number, label: string) => (
    <button
      key={ids[index] ?? 'unorganized'}
      id={`dc-move-menu-item-${index}`}
      type="button"
      role="menuitemradio"
      aria-checked={ids[index] === currentProjectId}
      className="dc-move-menu-row"
      data-highlighted={index === highlight ? 'true' : undefined}
      onPointerMove={() => {
        if (highlightRef.current !== index) setHighlight(index);
      }}
      onClick={(event) => {
        event.stopPropagation();
        onMove(ids[index]);
        onClose();
      }}
    >
      <Icon name="check" size={14} className="dc-move-menu-check" />
      <span>{label}</span>
    </button>
  );

  return (
    <div
      className="dc-move-menu"
      role="menu"
      aria-label="Move to project"
      aria-activedescendant={`dc-move-menu-item-${highlight}`}
      tabIndex={-1}
      ref={rootRef}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {row(0, 'Unorganized')}
      {projects.length > 0 && <span className="dc-move-menu-divider" />}
      {sortedProjects.map((project, index) => row(index + 1, project.name))}
    </div>
  );
}
