import { useUiStore } from '../../store/uiStore';
import { CanvasSettings } from '../settings/CanvasSettings';
import { SettingsDialog, type SettingsCategory } from '../settings/SettingsDialog';

const CATEGORIES: readonly [SettingsCategory, ...SettingsCategory[]] = [
  { id: 'canvas', label: 'Canvas', icon: 'pencil', Page: CanvasSettings },
];

/**
 * Settings on the web: the desktop app's Settings dialog, with the one page the web has — Canvas. The
 * desktop app sends every request for canvas settings (⌘K, the canvas's right-click, the status bar)
 * to its own Settings at that page instead — see `desktop/boot.ts`.
 */
export function CanvasSettingsDialog() {
  const open = useUiStore((state) => state.settingsOpen);
  const setOpen = useUiStore((state) => state.setSettingsOpen);
  if (!open) return null;
  return <SettingsDialog categories={CATEGORIES} current="canvas" onSelect={() => {}} onClose={() => setOpen(false)} />;
}
