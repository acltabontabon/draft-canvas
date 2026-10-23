import { SettingsDialog, type SettingsCategory as SettingsCategoryEntry } from '../../../ui/settings/SettingsDialog';
import { desktopStore, type SettingsCategory } from '../../store';
import { useDesktopController, useDesktopState } from '../../useDesktop';
import { RenameFileDialog } from '../RenameFileDialog';
import { UpdatePanel } from '../Updates';
import { DesktopExplorer } from '../DesktopExplorer';
import { AgentSettings } from './AgentSettings';
import { CanvasSettingsPage } from './CanvasSettingsPage';
import { GeneralSettings } from './GeneralSettings';
import { SupportSettings } from './SupportSettings';
import { UpdateSettings } from './UpdateSettings';
import '../desktop.css';
import './settings.css';

/**
 * The desktop app's own dialogs: Settings, the update panel the update chip opens, and "Rename file…",
 * however it was asked for (the menu, or a file's own action in Find a Diagram) — one dialog, reading
 * whichever target is set, plus the in-app project explorer.
 */
export function DesktopSettings() {
  return (
    <>
      <DesktopSettingsDialog />
      <RenameTargetDialog />
      <UpdatePanel />
      <DesktopExplorer />
    </>
  );
}

function RenameTargetDialog() {
  const { renameTarget, doc } = useDesktopState();
  const controller = useDesktopController();
  if (!renameTarget) return null;
  const onClose = () => desktopStore.update({ renameTarget: null });

  if (renameTarget.kind === 'open') {
    // The open document may have closed (or changed) between the menu firing and this rendering.
    if (doc.kind !== 'file') return null;
    return <RenameFileDialog currentName={doc.name} onSubmit={(newStem) => controller.renameOpenFile(newStem)} onClose={onClose} />;
  }
  if (renameTarget.kind === 'recent') {
    const { handle, name } = renameTarget;
    return <RenameFileDialog currentName={name} onSubmit={(newStem) => controller.renameFile(handle, newStem)} onClose={onClose} />;
  }
  const { project, relPath, name } = renameTarget;
  return <RenameFileDialog currentName={name} onSubmit={(newStem) => controller.renameProjectFile(project, relPath, newStem)} onClose={onClose} />;
}

/** Every page of Settings, in rail order. */
const CATEGORIES: readonly [SettingsCategoryEntry<SettingsCategory>, ...SettingsCategoryEntry<SettingsCategory>[]] = [
  { id: 'general', label: 'General', icon: 'sliders', Page: GeneralSettings },
  { id: 'canvas', label: 'Canvas', icon: 'pencil', Page: CanvasSettingsPage },
  { id: 'agents', label: 'AI agents', icon: 'agent', Page: AgentSettings },
  { id: 'updates', label: 'Updates', icon: 'refresh', Page: UpdateSettings },
  { id: 'support', label: 'Support', icon: 'help', Page: SupportSettings },
];

function DesktopSettingsDialog() {
  const { settingsOpen, settingsCategory } = useDesktopState();
  if (!settingsOpen) return null;
  return (
    <SettingsDialog
      categories={CATEGORIES}
      current={settingsCategory}
      onSelect={(id) => desktopStore.update({ settingsCategory: id })}
      onClose={() => desktopStore.update({ settingsOpen: false })}
    />
  );
}
