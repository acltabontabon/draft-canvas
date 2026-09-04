import { useEffect, useRef, useState } from 'react';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { DEV_PRESETS, PRESETS, type Preset } from '../../canvas/presets';
import { useIsNewFeature } from '../../learning/useNewFeature';
import { Button } from '../common/Button';
import { Icon } from '../common/Icon';
import { useTheme } from '../theme/useTheme';
import { FlowSwitcher } from './FlowSwitcher';

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
  const updateReady = useUiStore((state) => state.updateReady);
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
    <Button
      key={preset.id}
      variant="ghost"
      active={armed?.id === preset.id}
      title={`${preset.label} — ${preset.hint} (${preset.shortcut})`}
      onClick={() => arm(armed?.id === preset.id ? null : preset)}
    >
      {preset.label}
    </Button>
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
        <Button
          variant="ghost"
          active={armed === null}
          title="Select (Esc)"
          onClick={() => arm(null)}
        >
          Select
        </Button>
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
        <FlowSwitcher />
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
            title={updateReady ? 'About Draft Canvas — update ready' : 'About Draft Canvas'}
          />
          {updateReady && <span className="dc-update-dot" aria-hidden="true" />}
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
