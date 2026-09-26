import { ALT_SYMBOL, MOD_SYMBOL } from '../../lib/platform';

/*
 * The help screen's catalog, kept apart from `ShortcutSheet.tsx` so that file exports only its
 * component (Fast Refresh) and `tests/shortcut-catalog.test.ts` can cross-check these rows against
 * the command registry by id without importing React at all.
 */

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

/** Test seam: lets the shortcut-sheet tests pick out the rows backed by a real command. */
export function isCommandRow(row: Row): row is CommandRow {
  return 'commandId' in row;
}
export function isGestureRow(row: Row): row is GestureRow {
  return 'keys' in row;
}
export function isMouseRow(row: Row): row is MouseRow {
  return 'gesture' in row;
}

export interface Section {
  title: string;
  rows: Row[];
}

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
      { commandId: 'export', label: `Export (${mod} E also works)` },
    ],
  },
  {
    title: 'Navigation',
    rows: [
      { keys: ['Tab'], label: 'Move to the canvas — Shift+Tab moves back through the toolbar' },
      { keys: [alt, 'Arrow'], label: 'Select the nearest element in that direction' },
      { keys: [alt, 'Shift', '→'], label: 'Follow an outgoing connector' },
      { keys: [alt, 'Shift', '←'], label: 'Follow an incoming connector' },
      { commandId: 'edit-text', label: 'Open the selected element' },
      { commandId: 'look-inside', label: 'Look inside the selected shape' },
      { commandId: 'back-out', label: 'Back out to what contains it' },
      { keys: ['Shift', 'F10'], label: 'Context menu for the selection (or the Menu key)' },
      { keys: ['Esc'], label: 'Step back — out of editing, then a popover, then presenting, then the selection, then out of a shape' },
    ],
  },
  {
    title: 'Canvas',
    rows: [
      { commandId: 'fit' },
      { commandId: 'zoom-in' },
      { commandId: 'zoom-out' },
      { commandId: 'zoom-reset' },
      { keys: ['Space'], label: 'Hold, then drag to pan' },
      { keys: ['Arrow'], label: 'Nudge the selection — Shift+Arrow moves further' },
    ],
  },
  {
    title: 'Diagramming',
    rows: [
      { gesture: 'Double-click', label: 'Create here, or edit text' },
      { keys: [mod, 'K'], label: 'Create and place a shape without the mouse' },
      { gesture: 'Drag from a handle', label: 'Connect — drop on empty canvas to create and wire a node' },
      { keys: ['Tab'], label: 'Accept the suggested next element, when one is showing' },
      { keys: [']', '['], label: 'Next or previous suggestion — or ask; with none to give, pick the next shape' },
      { commandId: 'group' },
      { commandId: 'ungroup' },
      { commandId: 'text-toggle-bold', label: 'Bold (selected Text)' },
      { commandId: 'text-toggle-italic', label: 'Italic (selected Text)' },
    ],
  },
  {
    title: 'Open points',
    rows: [{ commandId: 'open-point-add', label: 'Raise an open point about the selection — the list of what is still open is in the status bar' }],
  },
  {
    title: 'Flows & presentation',
    rows: [
      { commandId: 'flow-manage', label: 'Flows panel' },
      { commandId: 'present', label: 'Start presenting' },
      { keys: ['→'], label: 'Next — begin, next step, then on to the next flow (Space also works)' },
      { keys: ['←'], label: 'Previous step — back to the opening from step 1' },
      { keys: ['1'], label: 'Jump to that step (1–9)' },
      { keys: ['Home'], label: 'First step' },
      { keys: ['End'], label: 'Last step' },
      { keys: ['O'], label: 'Overview — pull back to the whole flow, keeping the step; again to return' },
      { keys: ['R'], label: 'Re-centre — hand the camera back after panning by hand' },
      { keys: ['P'], label: 'Pointer — a soft ring that follows the cursor' },
      { keys: ['Shift', '→'], label: 'Next flow — without leaving the presentation' },
      { keys: ['Shift', '←'], label: 'Previous flow' },
      { keys: ['Shift', 'F'], label: 'Jump to any flow' },
      { keys: ['Esc'], label: 'Exit presenting' },
    ],
  },
];
