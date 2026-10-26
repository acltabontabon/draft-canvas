import { useEffect } from 'react';
import { SettingsDialog, type SettingsCategory as SettingsCategoryEntry } from '../../../ui/settings/SettingsDialog';
import { desktopStore, type SettingsCategory } from '../../store';
import { useDesktopController, useDesktopState } from '../../useDesktop';
import { resolveFileTarget } from '../fileTargets';
import { MoveToProjectDialog } from '../MoveToProjectDialog';
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
 * The desktop app's own dialogs: Settings, the update panel the update chip opens, "Rename file…" and
 * "Move to Project…", however they were asked for (the menu, or a file's own action on Home or in Find
 * a Diagram) — one dialog each, reading whichever target is set, plus the in-app project explorer.
 */
export function DesktopSettings() {
  return (
    <>
      <DesktopSettingsDialog />
      <RenameTargetDialog />
      <MoveTargetDialog />
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

function MoveTargetDialog() {
  const state = useDesktopState();
  const { moveTarget, projects } = state;
  const controller = useDesktopController();
  // Every project's count and names (for Keep both's preview): a listing each, names and dates only.
  const handles = moveTarget ? projects.map((project) => project.info.handle).join('|') : '';
  useEffect(() => {
    if (handles) void controller.scanProjects(handles.split('|'));
  }, [controller, handles]);
  if (!moveTarget) return null;
  const target = resolveFileTarget(moveTarget.file, state, controller);
  // The open document may have closed (or changed) between the menu firing and this rendering.
  if (!target) return null;
  return (
    <MoveToProjectDialog
      name={target.name}
      fromPath={target.fromPath}
      projects={projects}
      clash={moveTarget.clash}
      failed={moveTarget.failed}
      onMove={target.move}
      // Stays open over the explorer: a project added there joins this list, ready to choose.
      onAddProject={() => desktopStore.update({ explorerMode: 'project' })}
      onClose={() => desktopStore.update({ moveTarget: null })}
    />
  );
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
