import { AppearanceSettings } from '../../../ui/settings/AppearanceSettings';
import { CanvasSettings } from '../../../ui/settings/CanvasSettings';
import { useDesktopState } from '../../useDesktop';

/** Settings → Canvas. Home has no diagram to give a background. */
export function CanvasSettingsPage() {
  const { doc } = useDesktopState();
  return <CanvasSettings documentOpen={doc.kind !== 'none'} />;
}

/** Settings → Appearance. Home has no diagram to give a style. */
export function AppearanceSettingsPage() {
  const { doc } = useDesktopState();
  return <AppearanceSettings documentOpen={doc.kind !== 'none'} />;
}
