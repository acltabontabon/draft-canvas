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
  /** Shown only in the desktop app, where the command exists. */
  desktopOnly?: true;
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
      { keys: [mod, 'K'], label: 'Commands — search actions, shapes, and flows' },
      { commandId: 'undo' },
      { commandId: 'redo' },
      { commandId: 'copy' },
      { commandId: 'cut' },
      { commandId: 'paste' },
      { commandId: 'duplicate' },
      { commandId: 'delete', label: 'Delete selection' },
      { commandId: 'delete-keep-lines', label: 'Delete and join the connectors through it' },
      { commandId: 'select-all' },
      { commandId: 'export', label: `Export (${mod} E also works)` },
      { commandId: 'find-replace', label: 'Find and replace across every room' },
    ],
  },
  {
    title: 'Navigation',
    rows: [
      { keys: ['Tab'], label: 'Move to the canvas — Shift+Tab moves back through the toolbar' },
      { keys: [alt, 'Arrow'], label: 'Select the nearest shape in that direction' },
      { keys: [alt, 'Shift', '→'], label: 'Follow an outgoing connector' },
      { keys: [alt, 'Shift', '←'], label: 'Follow an incoming connector' },
      { commandId: 'edit-text', label: 'Rename or edit the selected shape (F2 also works)' },
      { commandId: 'look-inside', label: 'Look inside the selected shape' },
      { commandId: 'back-out', label: 'Back out to what contains it' },
      { keys: ['Shift', 'F10'], label: 'Context menu for the selection, or the canvas menu when nothing is selected (or the Menu key)' },
      { commandId: 'outline', label: 'Outline — this view as a list of shapes and their connectors, for the keyboard and screen readers' },
      { commandId: 'companion', label: 'Nodi — ask your coding agent about this diagram', desktopOnly: true },
      { keys: ['Esc'], label: 'Step back — out of editing, then a popover, then a next-shape suggestion, then presenting, then the selection, then a chosen flow, then out of a shape' },
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
      { gesture: 'Double-click', label: 'Create here, or edit text — a new shape opens ready to name' },
      { keys: ['Enter'], label: 'Finish a name — Esc puts the old one back' },
      { keys: [mod, 'Enter'], label: 'Finish a note, text or code — Esc keeps what you typed' },
      { keys: [mod, 'K'], label: 'Create and place a shape without the mouse' },
      { gesture: 'Drag from a handle', label: 'Connect — drop on empty canvas to create and wire a shape' },
      { keys: ['Tab'], label: 'Accept the next-shape suggestion, when one is showing' },
      { keys: [']', '['], label: 'Next or previous suggestion — or ask; with none to give, pick the next shape' },
      { commandId: 'turn-into-service', label: 'Turn the selection into a Service — keeps its connectors, flows and notes' },
      { commandId: 'turn-into-database', label: 'Turn into a Data Store' },
      { commandId: 'turn-into-queue', label: 'Turn into a Queue' },
      { commandId: 'turn-into-actor', label: 'Turn into an Actor' },
      { commandId: 'turn-into-component', label: 'Turn into a Component' },
      { gesture: 'Drop on a connector', label: 'Put an unconnected Queue, Data Store, Service, Component or Junction into the middle of it' },
      { gesture: 'Drag from a selected shape', label: 'Connect every selected shape to where you drop' },
      { keys: [alt], label: 'Hold while dragging or resizing — turns off snapping' },
      { commandId: 'group' },
      { commandId: 'ungroup' },
      { commandId: 'text-toggle-bold', label: 'Bold (selected Text)' },
      { commandId: 'text-toggle-italic', label: 'Italic (selected Text)' },
    ],
  },
  {
    title: 'Sequences',
    rows: [
      { keys: ['L'], label: 'New sequence — name who takes part, one Enter each' },
      { gesture: 'Drag between lifelines', label: 'Add a message — drag past the last one to add a participant with it' },
      { keys: [mod, '↓'], label: 'Step into the selected sequence — Esc steps back out' },
      { keys: [alt, 'Arrow'], label: 'Move the selection inside it — add Shift to extend' },
      { keys: ['Arrow'], label: 'Move the message up or down, or the participant left or right' },
      { keys: ['Tab'], label: 'Add the message that usually comes next — ] and [ offer others' },
      { keys: ['P'], label: 'Add a participant after the selected one' },
      { keys: [mod, 'G'], label: 'Wrap the selected messages, or group the selected participants' },
      { gesture: 'Drop a shape in', label: 'It stands in the sequence — a shape on its own moves in' },
    ],
  },
  {
    title: 'Pencil',
    rows: [
      { commandId: 'pencil-sketch', label: 'Pencil — press again to switch between Sketch and Smart Ink' },
      { commandId: 'pencil-highlighter', label: 'Highlighter' },
      { commandId: 'pencil-eraser', label: 'Eraser — a stylus’s eraser end erases too' },
      { keys: ['Esc'], label: 'Put the Pencil down; mid-stroke, take back that stroke' },
      { keys: ['←', '→'], label: 'Smart Ink: change what a drawing became' },
      { keys: ['Enter'], label: 'Smart Ink: keep it and name it' },
      { keys: ['Esc'], label: 'Smart Ink: keep the drawing as a sketch instead' },
      { gesture: 'Wheel, pinch or middle-drag', label: 'Pan and zoom while drawing' },
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
