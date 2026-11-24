import { AppearanceSettings } from '../../../ui/settings/AppearanceSettings';
import { CanvasSettings } from '../../../ui/settings/CanvasSettings';
import { useDesktopState } from '../../useDesktop';

/** Settings → Canvas. */
export function CanvasSettingsPage() {
  return <CanvasSettings />;
}

/** Settings → Appearance. Home has no diagram to give a style. */
export function AppearanceSettingsPage() {
  const { doc } = useDesktopState();
  return <AppearanceSettings documentOpen={doc.kind !== 'none'} />;
}
