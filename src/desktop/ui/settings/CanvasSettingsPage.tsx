import { CanvasSettings } from '../../../ui/settings/CanvasSettings';
import { useDesktopState } from '../../useDesktop';

/** Settings → Canvas. Home has no diagram to give a background. */
export function CanvasSettingsPage() {
  const { doc } = useDesktopState();
  return <CanvasSettings documentOpen={doc.kind !== 'none'} />;
}
