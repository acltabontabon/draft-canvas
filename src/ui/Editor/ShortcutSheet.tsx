import { useMemo, useState } from 'react';
import { ALL_PRESETS } from '../../canvas/presets';
import { shortcutFor, titleFor } from '../../commands/shortcutLookup';
import { useUiStore } from '../../store/uiStore';
import { Button } from '../common/Button';
import { Modal } from '../common/Modal';
import { isGestureRow, isMouseRow, SECTIONS, type Row } from './shortcutSections';

function Keycap({ keys }: { keys: string[] }) {
  return (
    <>
      {keys.map((key, index) => (
        // Chords can repeat a token (Alt+Shift+→/←'s own two rows each reuse "Shift") — index is
        // fine as a key here since this list is never reordered or filtered on its own.
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
  // Mounted only while open, so the filter starts empty each time.
  return open ? <ShortcutSheetBody /> : null;
}

function ShortcutSheetBody() {
  const setOpen = useUiStore((state) => state.setShortcutsOpen);
  const learnModeActive = useUiStore((state) => state.learnModeActive);
  const setLearnModeActive = useUiStore((state) => state.setLearnModeActive);
  const [query, setQuery] = useState('');

  const createRows = useMemo(
    () => ALL_PRESETS.map((preset) => ({ keys: [preset.shortcut], label: `${preset.label} — ${preset.hint}` })),
    [],
  );

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
