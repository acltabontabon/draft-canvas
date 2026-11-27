import { useCallback, useRef, useState } from 'react';
import { openLink } from '../../host/openLink';
import { PRODUCT } from '../../product';
import { useUiStore } from '../../store/uiStore';
import { Button } from '../common/Button';
import { Tooltip } from '../common/Tooltip';
import { useUnreadReleaseNotes } from '../common/useUnreadReleaseNotes';
import { ToolbarMenu, type ToolbarMenuItem } from './toolbar/ToolbarMenu';
import { toolbarLabel, toolbarTooltip } from './toolbar/toolbarTooltips';

/**
 * Appearance, one click from the corner where the app's other controls are: your style, the canvas
 * and its settings, in the panel beside the diagram. Pressed while that panel is open, and pressing
 * it again closes it. A right-click on the canvas and ⌘K reach it too, but neither is where anyone
 * looks first.
 */
export function CanvasSettingsButton() {
  const open = useUiStore((state) => state.stylePanelOpen);
  return (
    <Tooltip content={toolbarTooltip('settings')}>
      {(tip) => (
        <Button
          icon="palette"
          variant="quiet"
          active={open}
          aria-pressed={open}
          onClick={() => useUiStore.getState().setStylePanelOpen(!open)}
          aria-label={toolbarLabel('settings')}
          {...tip}
        />
      )}
    </Tooltip>
  );
}

/**
 * Help, in the corner where people look for it: the command palette, the shortcut sheet, the guides,
 * and About — which carries the dot when an update is ready or there is something new, so the "?"
 * carries it too. These used to sit behind a ⋯ in the header, beside things that act on the
 * diagram; the canvas's own actions (Arrange, Find and replace) are now a right-click on the canvas
 * away, and in ⌘K, and Appearance has its own button beside this one.
 */
export function HelpMenu() {
  const ref = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ rect: DOMRect; trigger: HTMLElement } | null>(null);
  const updateReady = useUiStore((state) => state.updateReady);
  const hasUnreadNotes = useUnreadReleaseNotes();
  const dot = updateReady ? 'update' : hasUnreadNotes ? 'new' : undefined;

  const close = useCallback(() => {
    setMenu(null);
    ref.current?.focus();
  }, []);
  const choose = (action: () => void) => () => {
    close();
    action();
  };
  const ui = useUiStore.getState;

  const items: ToolbarMenuItem[] = [
    { id: 'commands', label: toolbarLabel('commands'), shortcut: toolbarTooltip('commands').shortcut, onSelect: choose(() => ui().setCommandPaletteOpen(true)) },
    { id: 'shortcuts', label: toolbarLabel('shortcuts'), shortcut: toolbarTooltip('shortcuts').shortcut, onSelect: choose(() => ui().setShortcutsOpen(true)) },
    { id: 'help', label: toolbarLabel('help'), onSelect: choose(() => openLink(PRODUCT.links.docs)) },
    { id: 'about', label: toolbarLabel('about'), ...(dot ? { dot } : {}), onSelect: choose(() => ui().setAboutOpen(true)) },
    ...(!__DESKTOP__ ? [{ id: 'diagnostics', label: 'Diagnostic report…', onSelect: choose(() => ui().setDiagnosticsOpen(true)) }] : []),
  ];
  const state = dot === 'update' ? 'update ready' : dot === 'new' ? "what’s new" : undefined;

  return (
    <span className="dc-badge-anchor dc-help">
      <Tooltip content={{ title: 'Help' }}>
        {(tip) => (
          <Button
            ref={ref}
            variant="quiet"
            className="dc-help-button"
            active={menu !== null}
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            aria-label={state ? `Help — ${state}` : 'Help'}
            onClick={(event) => {
              const trigger = event.currentTarget;
              setMenu((open) => (open ? null : { rect: trigger.getBoundingClientRect(), trigger }));
            }}
            {...tip}
          >
            ?
          </Button>
        )}
      </Tooltip>
      {dot === 'update' ? <span className="dc-update-dot" aria-hidden="true" /> : dot === 'new' && <span className="dc-new-dot" aria-hidden="true" />}
      {menu && <ToolbarMenu label="Help" anchorRect={menu.rect} trigger={menu.trigger} items={items} onDismiss={close} placement="above" />}
    </span>
  );
}
