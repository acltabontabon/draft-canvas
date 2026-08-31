import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { DEV_PRESETS, PRESETS, type Preset } from '../../canvas/presets';
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
  const undo = useEditorStore((state) => state.undo);
  const redo = useEditorStore((state) => state.redo);
  const past = useEditorStore((state) => state.history.past.length);
  const future = useEditorStore((state) => state.history.future.length);
  const { name: themeName, toggle } = useTheme();

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
          value={title}
          maxLength={200}
          aria-label="Diagram title"
          onChange={(event) => onTitleChange(event.target.value)}
          onKeyDown={(event) => event.stopPropagation()}
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
