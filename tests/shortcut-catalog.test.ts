import { describe, expect, it } from 'vitest';
import { shortcutCatalog, shortcutFor } from '../src/commands/shortcutLookup';
import { isCommandRow, SECTIONS } from '../src/ui/Editor/shortcutSections';
import { MOD_SYMBOL } from '../src/lib/platform';

/**
 * Two things, both about keeping `ShortcutSheet.tsx` provably in sync with `registry.ts`:
 *
 * 1. `describe('shortcutCatalog')` confirms `shortcutLookup.ts`'s fixture-driven catalog actually
 *    reaches the commands it's meant to — the real regression risk for a fixture like this is that
 *    a future `registry.ts` change (a renamed field, a stricter gate) silently makes one of the
 *    fixture passes throw or come back empty, and this file would be the only thing to notice.
 * 2. `describe('ShortcutSheet cross-check')` is what actually enforces the "can't silently drift"
 *    property: every registry `Command` with a `shortcut` must have a matching `CommandRow` in
 *    `SECTIONS`, and every `CommandRow` there must name a real, shortcut-bearing command — so
 *    adding, removing, or renaming one without touching the other fails this test, not a user's
 *    eventual bug report.
 */
describe('shortcutCatalog', () => {
  const catalog = shortcutCatalog();

  const shortcutOf = (id: string) => catalog.get(id)?.shortcut;

  it('is non-empty and covers commands from every fixture pass', () => {
    // No-selection pass (canvasCommands/viewCommands/flowCommands via commandsFor).
    expect(shortcutOf('undo')).toBe(`${MOD_SYMBOL} Z`);
    expect(shortcutOf('redo')).toBe(`${MOD_SYMBOL} Shift Z`);
    expect(shortcutOf('select-all')).toBe(`${MOD_SYMBOL} A`);
    expect(shortcutOf('paste')).toBe(`${MOD_SYMBOL} V`);
    expect(shortcutOf('export')).toBe(`${MOD_SYMBOL} E`);
    expect(shortcutOf('shortcuts')).toBe('?');
    expect(shortcutOf('fit')).toBe('Shift 1');
    expect(shortcutOf('zoom-in')).toBe(`${MOD_SYMBOL} +`);
    expect(shortcutOf('zoom-out')).toBe(`${MOD_SYMBOL} −`);
    expect(shortcutOf('present')).toBe(`${MOD_SYMBOL} Enter`);
    expect(shortcutOf('flow-manage')).toBe('F');

    // Single-node pass (nodeCommands).
    expect(shortcutOf('edit-text')).toBe('Enter');
    expect(shortcutOf('duplicate')).toBe(`${MOD_SYMBOL} D`);
    expect(shortcutOf('copy')).toBe(`${MOD_SYMBOL} C`);
    expect(shortcutOf('cut')).toBe(`${MOD_SYMBOL} X`);
    expect(shortcutOf('delete')).toBe('Backspace');

    // Multi-selection pass (multiCommands): Group needs >=2 selected, Ungroup needs a boundary
    // among them — both present in the fixture's 3-plain-nodes-plus-a-boundary selection.
    expect(shortcutOf('group')).toBe(`${MOD_SYMBOL} G`);
    expect(shortcutOf('ungroup')).toBe(`${MOD_SYMBOL} Shift G`);

    // A representative sample of `ALL_PRESETS`' node-creation letter shortcuts, single-sourced
    // through `canvas/presets.ts` already — confirms this catalog reaches those too.
    expect(shortcutOf('add-service')).toBe('S');
    expect(shortcutOf('add-note')).toBe('N');
  });

  it('every entry carries the command\'s own title too, for rows with no label override', () => {
    expect(catalog.get('undo')?.title).toBe('Undo');
    expect(catalog.get('group')?.title).toBe('Group into boundary');
  });

  it('has no two distinct commands claiming the same shortcut', () => {
    const byShortcut = new Map<string, string[]>();
    for (const [id, entry] of catalog) {
      const ids = byShortcut.get(entry.shortcut) ?? [];
      ids.push(id);
      byShortcut.set(entry.shortcut, ids);
    }
    const collisions = [...byShortcut.entries()].filter(([, ids]) => ids.length > 1);
    expect(collisions).toEqual([]);
  });

  it('shortcutFor mirrors the catalog and is undefined for an unknown or shortcut-less id', () => {
    expect(shortcutFor('undo')).toBe(shortcutOf('undo'));
    expect(shortcutFor('not-a-real-command-id')).toBeUndefined();
    // 'settings' is a real command (Canvas settings…) with no bound key.
    expect(shortcutFor('settings')).toBeUndefined();
  });
});

describe('ShortcutSheet cross-check', () => {
  const catalog = shortcutCatalog();
  const commandRowIds = new Set(
    SECTIONS.flatMap((section) => section.rows).filter(isCommandRow).map((row) => row.commandId),
  );
  // Node-creation letter shortcuts (`add-service`, `add-note`, …) are covered by the sheet's
  // separate "Create" section, generated straight from `canvas/presets.ts` — not from `SECTIONS`,
  // so they're excluded here rather than double-counted.
  const catalogIdsOutsideCreate = [...catalog.keys()].filter((id) => !id.startsWith('add-'));

  it('every catalog command with a shortcut has a row in SECTIONS', () => {
    const missing = catalogIdsOutsideCreate.filter((id) => !commandRowIds.has(id));
    expect(missing).toEqual([]);
  });

  it('every SECTIONS row names a command that actually has a resolvable shortcut', () => {
    const dangling = [...commandRowIds].filter((id) => !catalog.has(id));
    expect(dangling).toEqual([]);
  });
});
