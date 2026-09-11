import { useEffect, useRef, useState } from 'react';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { DEV_PRESETS, PRESETS, SELECT_TOOLTIP, tooltipContentFor, type Preset } from '../../canvas/presets';
import { useIsNewFeature } from '../../learning/useNewFeature';
import { PRODUCT } from '../../product';
import { applicableReleases, hasUnreadRelease } from '../../releases/productReleases';
import { Button } from '../common/Button';
import { Icon } from '../common/Icon';
import { Tooltip } from '../common/Tooltip';
import { useTheme } from '../theme/useTheme';

interface ToolbarProps {
  title: string;
  onTitleChange: (title: string) => void;
  onBack: () => void;
  onFit: () => void;
  onPresent: () => void;
  onExport: () => void;
}

/**
 * One slim bar. Everything else is contextual.
 *
 * A permanent property inspector would cost thirty percent of the canvas to
 * show controls that are wrong for whatever is selected most of the time.
 */
export function Toolbar({
  title,
  onTitleChange,
  onBack,
  onFit,
  onPresent,
  onExport,
}: ToolbarProps) {
  const armed = useUiStore((state) => state.armed);
  const arm = useUiStore((state) => state.arm);
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
  const { name: themeName, toggle } = useTheme();

  // Edited locally and committed only on blur/Enter, like every other text field in the app
  // (node/edge text, edge label, condition/response) — never written to the store per keystroke.
  // `setTitle` trims the committed value; running that trim on every keystroke instead of once
  // would strip a space the instant it's typed, since it's momentarily the last character.
  //
  // `localTitleRef` (not just the `localTitle` state) is what onBlur commits: Escape calls
  // `blur()` synchronously right after reverting, before React has re-rendered the input with
  // the reverted value, so onBlur can't trust the DOM's own `.value` or a `localTitle` closure —
  // only a ref is guaranteed current at that point.
  const [localTitle, setLocalTitle] = useState(title);
  const localTitleRef = useRef(title);
  const editingTitleRef = useRef(false);
  const setLocalTitleValue = (value: string) => {
    localTitleRef.current = value;
    setLocalTitle(value);
  };
  useEffect(() => {
    if (!editingTitleRef.current) {
      localTitleRef.current = title;
      setLocalTitle(title);
    }
  }, [title]);

  const toolButton = (preset: Preset) => (
    <Tooltip key={preset.id} content={tooltipContentFor(preset)}>
      {(tip) => (
        <Button
          variant="ghost"
          active={armed?.id === preset.id}
          onClick={() => arm(armed?.id === preset.id ? null : preset)}
          {...tip}
        >
          {preset.label}
        </Button>
      )}
    </Tooltip>
  );

  return (
    <header className="dc-toolbar">
      <div className="dc-toolbar-group">
        <Button icon="back" variant="quiet" onClick={onBack} title="Back to your diagrams" />
        <input
          className="dc-title-input"
          value={localTitle}
          maxLength={200}
          aria-label="Diagram title"
          onFocus={() => {
            editingTitleRef.current = true;
          }}
          onChange={(event) => setLocalTitleValue(event.target.value)}
          onBlur={() => {
            editingTitleRef.current = false;
            onTitleChange(localTitleRef.current);
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter') {
              event.preventDefault();
              event.currentTarget.blur();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              setLocalTitleValue(title);
              event.currentTarget.blur();
            }
          }}
        />
      </div>

      <div className="dc-toolbar-group dc-toolbar-tools">
        <Tooltip content={SELECT_TOOLTIP}>
          {(tip) => (
            <Button variant="ghost" active={armed === null} onClick={() => arm(null)} {...tip}>
              Select
            </Button>
          )}
        </Tooltip>
        <span className="dc-toolbar-divider" />
        {PRESETS.map(toolButton)}
        <span className="dc-toolbar-divider" />
        {DEV_PRESETS.map(toolButton)}
      </div>

      <div className="dc-toolbar-group">
        <Button icon="undo" variant="quiet" disabled={past === 0} onClick={undo} title="Undo (Cmd+Z)" />
        <Button
          icon="redo"
          variant="quiet"
          disabled={future === 0}
          onClick={redo}
          title="Redo (Cmd+Shift+Z)"
        />
        <Button icon="fit" variant="quiet" onClick={onFit} title="Fit to view (Shift+1)" />
        <span className="dc-toolbar-divider" />
        <span className="dc-badge-anchor">
          <Button
            icon="search"
            variant="quiet"
            onClick={() => {
              retirePaletteBadge();
              setCommandPaletteOpen(true);
            }}
            title="Commands (Cmd+K)"
          />
          {paletteIsNew && <span className="dc-new-dot" aria-hidden="true" />}
        </span>
        {/* Reads as state, not a menu: "Flows" alone, or "Flows · Checkout" while one is active.
            Everything you can do to a flow lives in the panel this toggles. */}
        <Button
          variant="ghost"
          active={flowPanelOpen}
          className="dc-flow-toggle"
          onClick={() => setFlowPanelOpen(!flowPanelOpen)}
          title="Flows (F)"
        >
          Flows
          {activeFlowTitle && (
            <>
              <span className="dc-flow-toggle-sep" aria-hidden="true">
                ·
              </span>
              <span className="dc-flow-toggle-title">{activeFlowTitle}</span>
            </>
          )}
        </Button>
        <Button icon="present" variant="ghost" onClick={onPresent} title="Present (Cmd+Enter)" />
        <span className="dc-toolbar-divider" />
        <Button icon="export" variant="quiet" onClick={onExport} title="Export (Cmd+E)" />
        <Button
          icon="settings"
          variant="quiet"
          onClick={() => setSettingsOpen(true)}
          title="Canvas settings"
        />
        <span className="dc-badge-anchor">
          <Button
            icon="lightbulb"
            variant="quiet"
            active={learnModeActive}
            onClick={() => {
              retireLearnModeBadge();
              setLearnModeActive(!learnModeActive);
            }}
            title={learnModeActive ? 'Learn Draft Canvas — on' : 'Learn Draft Canvas'}
          />
          {learnModeIsNew && <span className="dc-new-dot" aria-hidden="true" />}
        </span>
        <Button
          icon="keyboard"
          variant="quiet"
          onClick={() => setShortcutsOpen(true)}
          title="Keyboard shortcuts (?)"
        />
        <span className="dc-badge-anchor">
          <Button
            icon="info"
            variant="quiet"
            onClick={() => setAboutOpen(true)}
            title={
              updateReady
                ? 'About Draft Canvas — update ready'
                : hasUnreadNotes
                  ? "About Draft Canvas — what's new"
                  : 'About Draft Canvas'
            }
          />
          {updateReady ? (
            <span className="dc-update-dot" aria-hidden="true" />
          ) : (
            hasUnreadNotes && <span className="dc-new-dot" aria-hidden="true" />
          )}
        </span>
        <Button
          variant="quiet"
          onClick={toggle}
          title={themeName === 'dark' ? 'Switch to light' : 'Switch to dark'}
          aria-label="Toggle theme"
        >
          <Icon name={themeName === 'dark' ? 'sun' : 'moon'} />
        </Button>
      </div>
    </header>
  );
}
