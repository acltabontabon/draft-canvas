import { useCallback, useRef, useState } from 'react';
import { useEditorStore } from '../../../store/editorStore';
import { useUiStore } from '../../../store/uiStore';
import { useIsNewFeature } from '../../../learning/useNewFeature';
import { PRODUCT } from '../../../product';
import { applicableReleases, hasUnreadRelease } from '../../../releases/productReleases';
import { Button } from '../../common/Button';
import { Tooltip } from '../../common/Tooltip';
import { ToolbarMenu, type ToolbarMenuItem } from './ToolbarMenu';
import { toolbarLabel, toolbarTooltip } from './toolbarTooltips';

interface ToolbarActionsProps {
  onPresent: () => void;
  onExport: () => void;
}

/**
 * Everything you do to the workspace, in three weights.
 *
 * History and utilities are quiet icons; Flows and Present carry words because they are modes you
 * enter, not commands you fire. The four app-level utilities behind `More` are the ones you touch
 * once a session — folding them up is what stops the right edge reading as an icon train, and the
 * trigger inherits their badges so nothing gets quietly buried.
 */
export function ToolbarActions({ onPresent, onExport }: ToolbarActionsProps) {
  const setShortcutsOpen = useUiStore((state) => state.setShortcutsOpen);
  const setAboutOpen = useUiStore((state) => state.setAboutOpen);
  const setSettingsOpen = useUiStore((state) => state.setSettingsOpen);
  const flowPanelOpen = useUiStore((state) => state.flowPanelOpen);
  const setFlowPanelOpen = useUiStore((state) => state.setFlowPanelOpen);
  const activeFlowTitle = useEditorStore((state) =>
    state.selectedFlowId ? state.document.flows.find((flow) => flow.id === state.selectedFlowId)?.title : undefined,
  );
  const updateReady = useUiStore((state) => state.updateReady);
  const lastSeenProductRelease = useUiStore((state) => state.lastSeenProductRelease);
  const hasUnreadNotes = hasUnreadRelease(lastSeenProductRelease, applicableReleases(PRODUCT.version));
  const learnModeActive = useUiStore((state) => state.learnModeActive);
  const setLearnModeActive = useUiStore((state) => state.setLearnModeActive);
  const { isNew: learnModeIsNew, retire: retireLearnModeBadge } = useIsNewFeature('learn-mode');
  const setCommandPaletteOpen = useUiStore((state) => state.setCommandPaletteOpen);
  const { isNew: paletteIsNew, retire: retirePaletteBadge } = useIsNewFeature('command-palette');
  const undo = useEditorStore((state) => state.undo);
  const redo = useEditorStore((state) => state.redo);
  const past = useEditorStore((state) => state.history.past.length);
  const future = useEditorStore((state) => state.history.future.length);

  const moreRef = useRef<HTMLButtonElement>(null);
  // The element as well as its rect: the menu needs the rect to place itself and the element to
  // tell its own trigger apart from an outside click. Captured in the handler rather than read
  // off the ref during render.
  const [menu, setMenu] = useState<{ rect: DOMRect; trigger: HTMLElement } | null>(null);
  const closeMenu = useCallback(() => {
    setMenu(null);
    // Focus goes back to the trigger, not to the top of the document — the menu was opened from
    // here and keyboard users need to still be here afterwards.
    moreRef.current?.focus();
  }, []);

  const aboutState = updateReady ? 'update ready' : hasUnreadNotes ? "what's new" : undefined;
  // The badges the folded-away items were carrying have to surface somewhere, or moving About
  // into a menu would silently hide "an update is ready". Update outranks unread outranks new.
  const escalatedDot = updateReady ? 'update' : hasUnreadNotes || learnModeIsNew ? 'new' : undefined;
  const moreState = aboutState ?? (learnModeIsNew ? 'new' : undefined);

  const menuItems: ToolbarMenuItem[] = [
    {
      id: 'settings',
      label: toolbarLabel('settings'),
      onSelect: () => {
        closeMenu();
        setSettingsOpen(true);
      },
    },
    {
      id: 'learn-mode',
      label: toolbarLabel('learn'),
      checked: learnModeActive,
      dot: learnModeIsNew ? 'new' : undefined,
      onSelect: () => {
        closeMenu();
        retireLearnModeBadge();
        setLearnModeActive(!learnModeActive);
      },
    },
    {
      id: 'shortcuts',
      label: toolbarLabel('shortcuts'),
      shortcut: toolbarTooltip('shortcuts').shortcut,
      onSelect: () => {
        closeMenu();
        setShortcutsOpen(true);
      },
    },
    {
      id: 'about',
      label: toolbarLabel('about'),
      dot: updateReady ? 'update' : hasUnreadNotes ? 'new' : undefined,
      onSelect: () => {
        closeMenu();
        setAboutOpen(true);
      },
    },
  ];

  return (
    <div className="dc-toolbar-trail">
      <div className="dc-toolbar-history">
        <Tooltip content={toolbarTooltip('undo')}>
          {(tip) => (
            <Button
              icon="undo"
              variant="quiet"
              disabled={past === 0}
              onClick={undo}
              aria-label={toolbarLabel('undo')}
              {...tip}
            />
          )}
        </Tooltip>
        <Tooltip content={toolbarTooltip('redo')}>
          {(tip) => (
            <Button
              icon="redo"
              variant="quiet"
              disabled={future === 0}
              onClick={redo}
              aria-label={toolbarLabel('redo')}
              {...tip}
            />
          )}
        </Tooltip>
      </div>

      {/* Modes you enter, not commands you fire. Both are built the same way — glyph, then word,
          one composed control — so they read as siblings rather than as two systems that happen to
          sit next to each other. Flows can be persistently on and takes the tint; Present is
          momentary, so it deliberately has no active state to fake. */}
      <div className="dc-toolbar-modes">
        <Tooltip content={toolbarTooltip('flows')}>
          {(tip) => (
            <Button
              icon="flow"
              variant="ghost"
              active={flowPanelOpen}
              className="dc-toolbar-mode dc-flow-toggle"
              onClick={() => setFlowPanelOpen(!flowPanelOpen)}
              aria-label={toolbarLabel('flows')}
              {...tip}
            >
              <span className="dc-mode-label">Flows</span>
              {activeFlowTitle && (
                <>
                  <span className="dc-flow-toggle-sep" aria-hidden="true">
                    ·
                  </span>
                  <span className="dc-flow-toggle-title">{activeFlowTitle}</span>
                </>
              )}
            </Button>
          )}
        </Tooltip>
        <Tooltip content={toolbarTooltip('present')}>
          {(tip) => (
            <Button
              icon="present"
              variant="ghost"
              className="dc-toolbar-mode"
              onClick={onPresent}
              aria-label={toolbarLabel('present')}
              {...tip}
            >
              <span className="dc-mode-label">Present</span>
            </Button>
          )}
        </Tooltip>
      </div>

      <div className="dc-toolbar-utilities">
        <span className="dc-badge-anchor">
          <Tooltip content={toolbarTooltip('commands')}>
            {(tip) => (
              <Button
                icon="search"
                variant="quiet"
                onClick={() => {
                  retirePaletteBadge();
                  setCommandPaletteOpen(true);
                }}
                aria-label={toolbarLabel('commands')}
                {...tip}
              />
            )}
          </Tooltip>
          {paletteIsNew && <span className="dc-new-dot" aria-hidden="true" />}
        </span>
        <Tooltip content={toolbarTooltip('export')}>
          {(tip) => (
            <Button
              icon="export"
              variant="quiet"
              onClick={onExport}
              aria-label={toolbarLabel('export')}
              {...tip}
            />
          )}
        </Tooltip>
        <span className="dc-badge-anchor">
          <Tooltip content={toolbarTooltip('more')}>
            {(tip) => (
              <Button
                ref={moreRef}
                icon="more"
                variant="quiet"
                active={menu !== null || learnModeActive}
                aria-haspopup="menu"
                aria-expanded={menu !== null}
                onClick={(event) => {
                  const trigger = event.currentTarget;
                  setMenu((open) => (open ? null : { rect: trigger.getBoundingClientRect(), trigger }));
                }}
                aria-label={moreState ? `${toolbarLabel('more')} — ${moreState}` : toolbarLabel('more')}
                {...tip}
              />
            )}
          </Tooltip>
          {escalatedDot === 'update' ? (
            <span className="dc-update-dot" aria-hidden="true" />
          ) : (
            escalatedDot === 'new' && <span className="dc-new-dot" aria-hidden="true" />
          )}
        </span>
      </div>

      {menu && (
        <ToolbarMenu
          anchorRect={menu.rect}
          trigger={menu.trigger}
          items={menuItems}
          onDismiss={closeMenu}
        />
      )}
    </div>
  );
}
