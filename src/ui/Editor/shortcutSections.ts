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
      { commandId: 'text-toggle-bold', label: 'Bold (selected Text)' },
      { commandId: 'text-toggle-italic', label: 'Italic (selected Text)' },
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
