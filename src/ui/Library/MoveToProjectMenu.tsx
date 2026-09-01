import { useEffect, useRef } from 'react';
import type { Project } from '../../document/types';
import { Icon } from '../common/Icon';

interface MoveToProjectMenuProps {
  currentProjectId: string | undefined;
  projects: Project[];
  onMove: (projectId: string | undefined) => void;
  onClose: () => void;
}

/**
 * A small popover listing Unorganized + every project, opened from a canvas
 * row's folder icon. Modeled on `FlowSwitcher.tsx`'s dropdown — the closest
 * existing menu pattern — rather than introducing a new generic Menu system
 * for this one use.
 */
export function MoveToProjectMenu({ currentProjectId, projects, onMove, onClose }: MoveToProjectMenuProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKeyDown, true);
    // Deferred one tick so the pointerdown that opened this menu doesn't also close it.
    const id = window.setTimeout(() => window.addEventListener('pointerdown', onPointerDown), 0);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown);
      window.clearTimeout(id);
    };
  }, [onClose]);

  const row = (id: string | undefined, label: string) => (
    <button
      key={id ?? 'unorganized'}
      type="button"
      role="menuitemradio"
      aria-checked={id === currentProjectId}
      className="dc-move-menu-row"
      onClick={(event) => {
        event.stopPropagation();
        onMove(id);
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
      ref={rootRef}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {row(undefined, 'Unorganized')}
      {projects.length > 0 && <span className="dc-move-menu-divider" />}
      {projects.map((project) => row(project.id, project.name))}
    </div>
  );
}
