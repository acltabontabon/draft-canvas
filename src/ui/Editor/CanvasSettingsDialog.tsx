import { useState } from 'react';
import { useUiStore, type SettingsPage } from '../../store/uiStore';
import { AppearanceSettings } from '../settings/AppearanceSettings';
import { CanvasSettings } from '../settings/CanvasSettings';
import { SettingsDialog, type SettingsCategory } from '../settings/SettingsDialog';

const CATEGORIES: readonly [SettingsCategory<SettingsPage>, ...SettingsCategory<SettingsPage>[]] = [
  { id: 'canvas', label: 'Canvas', icon: 'pencil', Page: CanvasSettings },
  { id: 'appearance', label: 'Appearance', icon: 'palette', Page: AppearanceSettings },
];

/**
 * Settings on the web: the desktop app's Settings dialog, with the pages the web has — Canvas and
 * Appearance. The desktop app sends every request for these (⌘K, the canvas's right-click, the
 * status bar) to its own Settings instead — see `desktop/boot.ts`.
 */
export function CanvasSettingsDialog() {
  const open = useUiStore((state) => state.settingsOpen);
  const first = useUiStore((state) => state.settingsPage);
  const setOpen = useUiStore((state) => state.setSettingsOpen);
  if (!open) return null;
  return <SettingsPages first={first} onClose={() => setOpen(false)} />;
}

/** Mounted only while Settings is open, so each time it opens on the page that was asked for. */
function SettingsPages({ first, onClose }: { first: SettingsPage; onClose: () => void }) {
  const [page, setPage] = useState<SettingsPage>(first);
  return <SettingsDialog categories={CATEGORIES} current={page} onSelect={setPage} onClose={onClose} />;
}
