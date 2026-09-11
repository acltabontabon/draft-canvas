import { useMemo, useState } from 'react';
import { ALL_PRESETS } from '../../canvas/presets';
import { shortcutFor, titleFor } from '../../commands/shortcutLookup';
import { ALT_SYMBOL, MOD_SYMBOL } from '../../lib/platform';
import { useUiStore } from '../../store/uiStore';
import { Button } from '../common/Button';
import { Modal } from '../common/Modal';

const mod = MOD_SYMBOL;
const alt = ALT_SYMBOL;

/** A row backed by a real registered `Command` — its key chips come from `shortcutFor`, the same
 *  field the palette/context-menu `<kbd>` chips already read, never hand-typed here. A command
 *  whose shortcut can't be resolved (removed, or gated on state this help screen's fixture doesn't
 *  construct — see `shortcutLookup.ts`) is simply skipped rather than shown wrong or stale. */
export interface CommandRow {
  commandId: string;
  /** Overrides the command's own `title` when the help-screen phrasing should read better. */
  label?: string;
}

/** A row for a real keyboard interaction that isn't a `Command` at all — Escape's own layered
 *  behavior, a chord this screen intentionally documents twice because its meaning genuinely
 *  depends on context, and so on. `keys` are real key tokens, one `<kbd>` chip each — never prose. */
export interface GestureRow {
  keys: string[];
  label: string;
}

/** A row for a mouse-only interaction with no keyboard equivalent — shown for discoverability
 *  (the brief for this screen explicitly asks for drag-to-connect, double-click-to-create, and
 *  friends), but never forced into a `<kbd>` chip, which is for keys. */
export interface MouseRow {
  gesture: string;
  label: string;
}

export type Row = CommandRow | GestureRow | MouseRow;

export function isCommandRow(row: Row): row is CommandRow {
  return 'commandId' in row;
}
function isGestureRow(row: Row): row is GestureRow {
  return 'keys' in row;
}
function isMouseRow(row: Row): row is MouseRow {
  return 'gesture' in row;
}

interface Section {
  title: string;
  rows: Row[];
}

/** Exported for `tests/shortcut-catalog.test.ts` — it cross-checks this list against the registry
 *  by id, not by rendering the component and scraping text. */
export const SECTIONS: Section[] = [
  {
    title: 'Essentials',
    rows: [
      { commandId: 'shortcuts', label: 'Keyboard shortcuts (this list)' },
      { keys: [mod, 'K'], label: 'Commands — search actions, elements, and flows' },
      { commandId: 'undo' },
      { commandId: 'redo' },
      { commandId: 'copy' },
      { commandId: 'cut' },
      { commandId: 'paste' },
      { commandId: 'duplicate' },
      { commandId: 'delete', label: 'Delete selection' },
      { commandId: 'select-all' },
      { commandId: 'export' },
    ],
  },
  {
    title: 'Navigation',
    rows: [
      { keys: ['Tab'], label: 'Move to the canvas — Shift+Tab moves back through the toolbar' },
      { keys: [alt, 'Arrow'], label: 'Select the nearest element in that direction' },
      { keys: [alt, 'Shift', '→'], label: 'Follow an outgoing connection' },
      { keys: [alt, 'Shift', '←'], label: 'Follow an incoming connection' },
      { commandId: 'edit-text', label: 'Open the selected element' },
      { keys: ['Shift', 'F10'], label: 'Context menu for the selection (or the Menu key)' },
      { keys: ['Esc'], label: 'Step back — out of editing, then a popover, then presenting, then the selection' },
    ],
  },
  {
    title: 'Canvas',
    rows: [
      { commandId: 'fit' },
      { commandId: 'zoom-in' },
      { commandId: 'zoom-out' },
      { keys: ['Space'], label: 'Hold, then drag to pan' },
      { keys: ['Arrow'], label: 'Nudge the selection — Shift+Arrow moves further' },
    ],
  },
  {
    title: 'Diagramming',
    rows: [
      { gesture: 'Double-click', label: 'Create here, or edit text' },
      { gesture: 'Drag from a handle', label: 'Connect — drop on empty canvas to create and wire a node' },
      { keys: ['Tab'], label: 'Accept the suggested next element, when one is showing' },
      { commandId: 'group' },
      { commandId: 'ungroup' },
    ],
  },
  {
    title: 'Flows & presentation',
    rows: [
      { commandId: 'flow-manage', label: 'Flows panel' },
      { commandId: 'present', label: 'Start presenting' },
      { keys: ['→'], label: 'Next step (Space also works)' },
      { keys: ['←'], label: 'Previous step' },
      { keys: ['Esc'], label: 'Exit presenting' },
    ],
  },
];

function Keycap({ keys }: { keys: string[] }) {
  return (
    <>
      {keys.map((key, index) => (
        // Chords can repeat a token (Alt+Shift+→/←'s own two rows each reuse "Shift") — index is
        // fine as a key here since this list is never reordered or filtered on its own.
        // eslint-disable-next-line react/no-array-index-key
        <kbd key={index}>{key}</kbd>
      ))}
    </>
  );
}

function matches(query: string, ...haystack: (string | undefined)[]): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return haystack.some((value) => value?.toLowerCase().includes(needle));
}

export function ShortcutSheet() {
  const open = useUiStore((state) => state.shortcutsOpen);
  const setOpen = useUiStore((state) => state.setShortcutsOpen);
  const learnModeActive = useUiStore((state) => state.learnModeActive);
  const setLearnModeActive = useUiStore((state) => state.setLearnModeActive);
  const [query, setQuery] = useState('');

  const createRows = useMemo(
    () => ALL_PRESETS.map((preset) => ({ keys: [preset.shortcut], label: `${preset.label} — ${preset.hint}` })),
    [],
  );

  if (!open) return null;

  const rowMatches = (row: Row) =>
    isGestureRow(row)
      ? matches(query, ...row.keys, row.label)
      : isMouseRow(row)
        ? matches(query, row.gesture, row.label)
        : matches(query, shortcutFor(row.commandId), row.label ?? titleFor(row.commandId));

  const sectionsToShow = SECTIONS.map((section) => ({ ...section, rows: section.rows.filter(rowMatches) })).filter(
    (section) => section.rows.length > 0,
  );
  const createRowsToShow = createRows.filter((row) => matches(query, ...row.keys, row.label));
  const nothingMatched = sectionsToShow.length === 0 && createRowsToShow.length === 0;

  return (
    <Modal title="Keyboard shortcuts" width={680} onClose={() => setOpen(false)}>
      <div className="dc-shortcuts">
        <input
          className="dc-shortcuts-search"
          type="search"
          placeholder="Filter shortcuts…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Filter shortcuts"
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- this dialog exists to be scanned or filtered immediately
          autoFocus
        />
        <div className="dc-shortcuts-grid">
          {createRowsToShow.length > 0 && (
            <section>
              <h3>Create</h3>
              <dl>
                {createRowsToShow.map((row) => (
                  <div key={row.keys[0]}>
                    <dt>
                      <Keycap keys={row.keys} />
                    </dt>
                    <dd>{row.label}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
          {sectionsToShow.map((section) => (
            <section key={section.title}>
              <h3>{section.title}</h3>
              <dl>
                {section.rows.map((row) => {
                  if (isMouseRow(row)) {
                    return (
                      <div key={row.gesture}>
                        <dt className="dc-shortcut-gesture">{row.gesture}</dt>
                        <dd>{row.label}</dd>
                      </div>
                    );
                  }
                  if (isGestureRow(row)) {
                    return (
                      <div key={row.keys.join('+') + row.label}>
                        <dt>
                          <Keycap keys={row.keys} />
                        </dt>
                        <dd>{row.label}</dd>
                      </div>
                    );
                  }
                  const keys = shortcutFor(row.commandId);
                  if (!keys) return null;
                  return (
                    <div key={row.commandId}>
                      <dt>
                        <Keycap keys={keys.split(' ')} />
                      </dt>
                      <dd>{row.label ?? titleFor(row.commandId)}</dd>
                    </div>
                  );
                })}
              </dl>
            </section>
          ))}
          {nothingMatched && <p className="dc-muted dc-shortcuts-empty">No shortcuts match “{query}”.</p>}
        </div>
        <section className="dc-shortcuts-guidance">
          <p className="dc-muted">
            Turn on Learn Draft Canvas mode to see every contextual hint again, even ones you've
            already dismissed or learned.
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
      </div>
    </Modal>
  );
}
