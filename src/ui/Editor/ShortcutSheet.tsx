import { ALL_PRESETS } from '../../canvas/presets';
import { MOD_LABEL } from '../../lib/platform';
import { useUiStore } from '../../store/uiStore';
import { Button } from '../common/Button';
import { Modal } from '../common/Modal';

const mod = MOD_LABEL;

const GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: 'Editing',
    items: [
      [`${mod} K`, 'Commands — search actions, elements, and flows'],
      [`${mod} Z`, 'Undo'],
      [`${mod} Shift Z`, 'Redo'],
      [`${mod} C`, 'Copy'],
      [`${mod} X`, 'Cut'],
      [`${mod} V`, 'Paste'],
      [`${mod} D`, 'Duplicate'],
      [`${mod} A`, 'Select all'],
      ['Backspace', 'Delete selection'],
      ['Esc', 'Clear selection'],
      ['Double-click', 'Create, or edit text'],
      ['Drag from edge', 'Connect — drop on empty canvas to make a node'],
      ['Right-click', 'Context menu — actions for what you clicked (or Shift F10 / Menu key)'],
    ],
  },
  {
    title: 'View',
    items: [
      ['Shift 1', 'Fit to view'],
      [`${mod} +`, 'Zoom in'],
      [`${mod} −`, 'Zoom out'],
      ['Space + drag', 'Pan'],
      ['F', 'Flows panel'],
      [`${mod} Enter`, 'Present'],
      [`${mod} E`, 'Export'],
      ['→ ←', 'Next / previous step in a walkthrough'],
    ],
  },
];

export function ShortcutSheet() {
  const open = useUiStore((state) => state.shortcutsOpen);
  const setOpen = useUiStore((state) => state.setShortcutsOpen);
  const learnModeActive = useUiStore((state) => state.learnModeActive);
  const setLearnModeActive = useUiStore((state) => state.setLearnModeActive);
  if (!open) return null;

  return (
    <Modal title="Keyboard shortcuts" width={620} onClose={() => setOpen(false)}>
      <div className="dc-shortcuts">
        <section>
          <h3>Guidance</h3>
          <p className="dc-muted">
            Turn on Learn Draft Canvas mode to see every contextual hint again, even ones you've
            already dismissed or learned — a deliberate pass instead of picking them up
            incidentally.
          </p>
          <Button
            variant="quiet"
            icon="lightbulb"
            active={learnModeActive}
            onClick={() => setLearnModeActive(!learnModeActive)}
          >
            {learnModeActive ? 'Learn Draft Canvas mode is on' : 'Turn on Learn Draft Canvas mode'}
          </Button>
        </section>
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
