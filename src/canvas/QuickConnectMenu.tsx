import { useEffect, useRef } from 'react';
import { QUICK_CONNECT_PRESETS, type Preset } from './presets';

export interface QuickConnectMenuProps {
  /** Screen coordinates — fixed for the life of the menu. */
  screenPosition: { x: number; y: number };
  onSelect: (preset: Preset) => void;
  onDismiss: () => void;
}

/**
 * The tiny type picker offered when a connection is dragged onto empty
 * canvas. Deliberately a plain list driven by `QUICK_CONNECT_PRESETS` — not
 * bespoke JSX per option — so a later pass can add arrow-key navigation or
 * promote a recently-used type without restructuring this component.
 */
export function QuickConnectMenu({ screenPosition, onSelect, onDismiss }: QuickConnectMenuProps) {
  const panel = useRef<HTMLDivElement>(null);

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

  return (
    <div
      ref={panel}
      className="dc-quick-connect"
      role="menu"
      aria-label="Create and connect"
      style={{ left: screenPosition.x, top: screenPosition.y }}
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
