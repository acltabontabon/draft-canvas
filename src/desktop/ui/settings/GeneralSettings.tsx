import type { CloseBehavior } from '../../api';
import { useDesktopController, useDesktopState } from '../../useDesktop';
import { ChoiceRow, SettingsPage, SettingsSection } from './layout';

/** Settings → General: what closing the window does. */
export function GeneralSettings() {
  const { settings, platform } = useDesktopState();
  const controller = useDesktopController();
  const place = platform === 'macos' ? 'the menu bar' : 'the system tray';
  const choices: { value: CloseBehavior; label: string; description: string }[] = [
    { value: 'tray', label: `Keep running in ${place}`, description: 'The window hides. Draft Canvas stays a click away and uses next to nothing.' },
    { value: 'quit', label: 'Quit Draft Canvas', description: 'Closing the window ends the app.' },
    { value: 'ask', label: 'Ask me next time', description: 'Hides the window, then asks once whether that is what you want.' },
  ];

  return (
    <SettingsPage title="General">
      <SettingsSection title="When you close the window" group>
        {choices.map((choice) => (
          <ChoiceRow
            key={choice.value}
            type="radio"
            name="close-behavior"
            label={choice.label}
            description={choice.description}
            checked={settings.closeBehavior === choice.value}
            onChange={() => void controller.setCloseBehavior(choice.value)}
          />
        ))}
      </SettingsSection>
    </SettingsPage>
  );
}
