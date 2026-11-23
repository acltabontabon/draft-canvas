import { useReactFlow } from '@xyflow/react';
import { useEffect, useRef } from 'react';
import { motionMs } from '../../lib/motion';
import { flowFitViewNodes, hasSomethingToFit, useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { Button } from '../common/Button';
import { AppearanceSettings } from '../settings/AppearanceSettings';

/**
 * Appearance, beside the canvas.
 *
 * A style is judged on a real diagram, so with one open this is where it is chosen and changed:
 * docked like the Outline, never over the canvas, so every pick is seen at once on the diagram
 * itself, which is framed again in the narrower canvas as the panel opens and stays live (pan it,
 * zoom it, select in it) while it is open. The same
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
  const { fitView, getZoom } = useReactFlow();
  // Asked for from the keyboard (⌘K), so the keyboard arrives in it.
  useEffect(() => {
    panel.current?.focus();
  }, []);
  /**
   * The panel takes its width from the canvas, so a diagram that filled the view now runs under
   * it. It is framed again in the room that is left: the diagram is what every choice here is
   * judged on, and half of it is no picture. Never closer than it was: a small diagram is moved
   * into view, not blown up. Two frames on, once the canvas has its new width.
   */
  useEffect(() => {
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        const state = useEditorStore.getState();
        if (hasSomethingToFit(state)) void fitView({ padding: 0.2, duration: motionMs(320), maxZoom: getZoom(), nodes: flowFitViewNodes(state) });
      });
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [fitView, getZoom]);
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
