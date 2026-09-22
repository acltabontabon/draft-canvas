import { Modal } from '../../ui/common/Modal';
import type { CloseBehavior } from '../api';
import { desktopStore } from '../store';
import { useDesktopController, useDesktopState } from '../useDesktop';
import { UpdatePanel, UpdateSettings } from './Updates';
import './desktop.css';

/**
 * The desktop app's own dialogs: Settings, and the update panel the update chip opens. Everything else
 * follows the OS.
 */
export function DesktopSettings() {
  return (
    <>
      <SettingsDialog />
      <UpdatePanel />
    </>
  );
}

/** What closing the window does, and updates. */
function SettingsDialog() {
  const { settingsOpen, settings, platform } = useDesktopState();
  const controller = useDesktopController();
  if (!settingsOpen) return null;

  const place = platform === 'macos' ? 'the menu bar' : 'the system tray';
  const choices: { value: CloseBehavior; label: string; hint: string }[] = [
    { value: 'tray', label: `Keep Draft Canvas in ${place}`, hint: 'It stays a click away, and uses next to nothing while the window is hidden.' },
    { value: 'quit', label: 'Quit Draft Canvas', hint: 'Closing the window ends the app.' },
    { value: 'ask', label: 'Ask me next time', hint: 'Hides the window, and asks once whether that is what you want.' },
  ];

  return (
    <Modal title="Settings" onClose={() => desktopStore.update({ settingsOpen: false })} width={500}>
      <fieldset className="dc-settings-group">
        <legend>When I close the window</legend>
        {choices.map((choice) => (
          <label key={choice.value} className="dc-settings-choice">
            <input
              type="radio"
              name="close-behavior"
              checked={settings.closeBehavior === choice.value}
              onChange={() => void controller.setCloseBehavior(choice.value)}
            />
            <span>
              {choice.label}
              <span className="dc-muted dc-settings-hint">{choice.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <UpdateSettings />
    </Modal>
  );
}
