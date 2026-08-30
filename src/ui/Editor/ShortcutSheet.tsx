import { ALL_PRESETS } from '../../canvas/presets';
import { useUiStore } from '../../store/uiStore';
import { Modal } from '../common/Modal';

const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const mod = isMac ? 'Cmd' : 'Ctrl';

const GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: 'Editing',
    items: [
      [`${mod} Z`, 'Undo'],
      [`${mod} Shift Z`, 'Redo'],
      [`${mod} C`, 'Copy'],
      [`${mod} V`, 'Paste'],
      [`${mod} D`, 'Duplicate'],
      [`${mod} A`, 'Select all'],
      ['Backspace', 'Delete selection'],
      ['Esc', 'Clear selection'],
      ['Double-click', 'Create, or edit text'],
      ['Drag from edge', 'Connect — drop on empty canvas to make a node'],
    ],
  },
  {
    title: 'View',
    items: [
      ['Shift 1', 'Fit to view'],
      [`${mod} +`, 'Zoom in'],
      [`${mod} −`, 'Zoom out'],
      ['Space + drag', 'Pan'],
      [`${mod} Enter`, 'Present'],
      [`${mod} E`, 'Export'],
      ['→ ←', 'Next / previous step in a walkthrough'],
    ],
  },
];

export function ShortcutSheet() {
  const open = useUiStore((state) => state.shortcutsOpen);
  const setOpen = useUiStore((state) => state.setShortcutsOpen);
  if (!open) return null;

  return (
    <Modal title="Keyboard shortcuts" width={620} onClose={() => setOpen(false)}>
      <div className="dc-shortcuts">
        <section>
          <h3>Create</h3>
          <dl>
            {ALL_PRESETS.map((preset) => (
              <div key={preset.id}>
                <dt>
                  <kbd>{preset.shortcut}</kbd>
                </dt>
                <dd>
                  {preset.label} <span className="dc-muted">— {preset.hint}</span>
                </dd>
              </div>
            ))}
          </dl>
        </section>
        {GROUPS.map((group) => (
          <section key={group.title}>
            <h3>{group.title}</h3>
            <dl>
              {group.items.map(([keys, description]) => (
                <div key={keys}>
                  <dt>
                    {keys.split(' ').map((key) => (
                      <kbd key={key}>{key}</kbd>
                    ))}
                  </dt>
                  <dd>{description}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}
