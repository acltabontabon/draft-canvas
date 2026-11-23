import { useEffect, useRef } from 'react';
import { useUiStore } from '../../store/uiStore';
import { Button } from '../common/Button';
import { AppearanceSettings } from '../settings/AppearanceSettings';

/**
 * Appearance, beside the canvas.
 *
 * A style is judged on a real diagram, so with one open this is where it is chosen and changed:
 * docked like the Outline, never over the canvas, so every pick is seen at once on the diagram
 * itself, which stays live (pan it, zoom it, select in it) while the panel is open. The same
 * `AppearanceSettings` the desktop app's Settings page shows on Home, laid out for a column.
 */
export function StylePanel() {
  const open = useUiStore((state) => state.stylePanelOpen);
  if (!open) return null;
  return <Panel />;
}

function Panel() {
  const panel = useRef<HTMLElement>(null);
  const close = () => {
    useUiStore.getState().setStylePanelOpen(false);
    document.querySelector<HTMLElement>('.dc-canvas')?.focus();
  };
  // Asked for from the keyboard (⌘K), so the keyboard arrives in it.
  useEffect(() => {
    panel.current?.focus();
  }, []);
  return (
    <aside
      ref={panel}
      className="dc-style-panel"
      role="complementary"
      aria-label="Appearance"
      tabIndex={-1}
      data-dc-keyboard-region=""
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        event.stopPropagation();
        close();
      }}
    >
      <header className="dc-style-panel-header">
        <div>
          <h2 className="dc-style-panel-title">Appearance</h2>
          <p className="dc-style-panel-lead">Seen on your diagram as you choose.</p>
        </div>
        <Button variant="quiet" icon="close" aria-label="Close appearance" onClick={close} />
      </header>
      <div className="dc-style-panel-body dc-prefs">
        <AppearanceSettings layout="panel" />
      </div>
    </aside>
  );
}
