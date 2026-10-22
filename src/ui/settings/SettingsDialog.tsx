import { useId, useRef, type ComponentType, type KeyboardEvent } from 'react';
import { Icon, type IconName } from '../common/Icon';
import { Modal } from '../common/Modal';
import '../Library/library-theme.css';
import '../Library/project-dialog.css';
import './settings.css';

/** A page of Settings. A new page is one entry in a host's list and a component built from `layout.tsx`. */
export interface SettingsCategory<Id extends string = string> {
  id: Id;
  label: string;
  icon: IconName;
  Page: ComponentType;
}

const KEY_STEP: Record<string, number> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };

interface SettingsDialogProps<Id extends string> {
  categories: readonly [SettingsCategory<Id>, ...SettingsCategory<Id>[]];
  current: Id;
  onSelect: (id: Id) => void;
  onClose: () => void;
}

/**
 * The one Settings dialog: the desktop app's (General, Canvas, AI agents, Updates, Support) and the
 * web's (Canvas). A rail of pages beside the one showing; the page is the only thing that scrolls.
 */
export function SettingsDialog<Id extends string>({ categories, current: currentId, onSelect, onClose }: SettingsDialogProps<Id>) {
  const baseId = useId();
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);

  const index = Math.max(
    0,
    categories.findIndex((category) => category.id === currentId),
  );
  const current = categories[index] ?? categories[0];
  const select = (next: number) => {
    const category = categories[next];
    if (!category) return;
    onSelect(category.id);
    tabs.current[next]?.focus();
  };
  // Selection follows focus: moving along the rail shows each page, as a native settings window does.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const last = categories.length - 1;
    const step = KEY_STEP[event.key];
    const next = step !== undefined ? (index + step + categories.length) % categories.length : event.key === 'Home' ? 0 : event.key === 'End' ? last : null;
    if (next === null) return;
    event.preventDefault();
    select(next);
  };

  return (
    <Modal title="Settings" onClose={onClose} width={900} className="dc-modal-settings dc-project-dialog">
      <nav className="dc-prefs-rail" aria-label="Settings">
        <div role="tablist" aria-label="Settings category" aria-orientation="vertical" onKeyDown={onKeyDown}>
          {categories.map((category, i) => {
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
