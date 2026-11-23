import { useState } from 'react';
import { useUiStore, type SettingsPage } from '../../store/uiStore';
import { CanvasSettings } from '../settings/CanvasSettings';
import { SettingsDialog, type SettingsCategory } from '../settings/SettingsDialog';

const CATEGORIES: readonly [SettingsCategory<SettingsPage>, ...SettingsCategory<SettingsPage>[]] = [
  { id: 'canvas', label: 'Canvas', icon: 'pencil', Page: CanvasSettings },
];

/**
 * Settings on the web: the desktop app's Settings dialog, with the page the web has, Canvas. The
 * desktop app sends every request for it (⌘K, the canvas's right-click, the status bar) to its own
 * Settings instead — see `desktop/boot.ts`. Appearance is not here: with a diagram open it is the
 * panel beside the canvas (`StylePanel.tsx`), where a change is seen on the diagram.
 */
export function CanvasSettingsDialog() {
  const open = useUiStore((state) => state.settingsOpen);
  const first = useUiStore((state) => state.settingsPage);
  const setOpen = useUiStore((state) => state.setSettingsOpen);
  if (!open) return null;
  return <SettingsPages first={first === 'appearance' ? 'canvas' : first} onClose={() => setOpen(false)} />;
}

/** Mounted only while Settings is open, so each time it opens on the page that was asked for. */
function SettingsPages({ first, onClose }: { first: SettingsPage; onClose: () => void }) {
  const [page, setPage] = useState<SettingsPage>(first);
  return <SettingsDialog categories={CATEGORIES} current={page} onSelect={setPage} onClose={onClose} />;
}
