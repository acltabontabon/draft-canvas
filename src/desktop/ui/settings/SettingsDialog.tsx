import { useId, useRef, type ComponentType, type KeyboardEvent } from 'react';
import { Icon, type IconName } from '../../../ui/common/Icon';
import { Modal } from '../../../ui/common/Modal';
import { desktopStore, type SettingsCategory } from '../../store';
import { useDesktopController, useDesktopState } from '../../useDesktop';
import { RenameFileDialog } from '../RenameFileDialog';
import { UpdatePanel } from '../Updates';
import { AgentSettings } from './AgentSettings';
import { GeneralSettings } from './GeneralSettings';
import { UpdateSettings } from './UpdateSettings';
import '../desktop.css';
import './settings.css';

/**
 * The desktop app's own dialogs: Settings, the update panel the update chip opens, and "Rename file…",
 * however it was asked for (the menu, or a file's own action in Find a Diagram) — one dialog, reading
 * whichever target is set. Everything else follows the OS.
 */
export function DesktopSettings() {
  return (
    <>
      <SettingsDialog />
      <RenameTargetDialog />
      <UpdatePanel />
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

/** Every page of Settings, in rail order. A new page is one entry here and a component built from `layout.tsx`. */
interface Category {
  id: SettingsCategory;
  label: string;
  icon: IconName;
  Page: ComponentType;
}

const CATEGORIES: readonly [Category, ...Category[]] = [
  { id: 'general', label: 'General', icon: 'sliders', Page: GeneralSettings },
  { id: 'agents', label: 'AI agents', icon: 'agent', Page: AgentSettings },
  { id: 'updates', label: 'Updates', icon: 'refresh', Page: UpdateSettings },
];

const KEY_STEP: Record<string, number> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };

/** A rail of pages beside the one showing. The page is the only thing that scrolls. */
function SettingsDialog() {
  const { settingsOpen, settingsCategory } = useDesktopState();
  const baseId = useId();
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  if (!settingsOpen) return null;

  const index = Math.max(
    0,
    CATEGORIES.findIndex((category) => category.id === settingsCategory),
  );
  const current = CATEGORIES[index] ?? CATEGORIES[0];
  const select = (next: number) => {
    const category = CATEGORIES[next];
    if (!category) return;
    desktopStore.update({ settingsCategory: category.id });
    tabs.current[next]?.focus();
  };
  // Selection follows focus: moving along the rail shows each page, as a native settings window does.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const last = CATEGORIES.length - 1;
    const step = KEY_STEP[event.key];
    const next = step !== undefined ? (index + step + CATEGORIES.length) % CATEGORIES.length : event.key === 'Home' ? 0 : event.key === 'End' ? last : null;
    if (next === null) return;
    event.preventDefault();
    select(next);
  };

  return (
    <Modal title="Settings" onClose={() => desktopStore.update({ settingsOpen: false })} width={960} className="dc-modal-settings">
      <nav className="dc-prefs-rail" aria-label="Settings">
        <div role="tablist" aria-label="Settings category" aria-orientation="vertical" onKeyDown={onKeyDown}>
          {CATEGORIES.map((category, i) => {
            const selected = i === index;
            return (
              <button
                key={category.id}
                ref={(element) => {
                  tabs.current[i] = element;
                }}
                type="button"
                role="tab"
                id={`${baseId}-tab-${category.id}`}
                className="dc-prefs-tab"
                aria-selected={selected}
                aria-controls={`${baseId}-panel`}
                tabIndex={selected ? 0 : -1}
                // Opening Settings puts focus on the page it opens at, so arrows move along the rail at once.
                autoFocus={selected}
                onClick={() => select(i)}
              >
                <Icon name={category.icon} size={16} />
                <span>{category.label}</span>
              </button>
            );
          })}
        </div>
      </nav>
      <div
        // Keyed by page, so each one opens at its top rather than wherever the last one was scrolled to.
        key={current.id}
        role="tabpanel"
        id={`${baseId}-panel`}
        aria-labelledby={`${baseId}-tab-${current.id}`}
        className="dc-prefs-panel"
      >
        <current.Page />
      </div>
    </Modal>
  );
}
