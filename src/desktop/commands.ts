import { isEditableTarget } from '../lib/isEditableTarget';

/**
 * Undo, Redo and Select All from the native Edit menu.
 *
 * They can't be the menu's own built-in items: on macOS those act on the webview's text editing, so
 * "Undo" would step back through typing in a field and never reach the canvas's history. So the
 * menu only tells the app, and this does what the keys would have done.
 *
 * In a text field the browser's own editing is right. Anywhere else the chord is handed to the
 * editor's key handler — the same one a real keypress reaches — so every guard it has (a dialog
 * open, a drag in progress, presenting) applies to the menu exactly as it does to the keys.
 */
export function dispatchEditCommand(command: 'undo' | 'redo' | 'select-all'): void {
  if (isEditableTarget(document.activeElement)) {
    document.execCommand(command === 'select-all' ? 'selectAll' : command);
    return;
  }
  const chord: KeyboardEventInit =
    command === 'undo'
      ? { key: 'z' }
      : command === 'redo'
        ? { key: 'z', shiftKey: true }
        : { key: 'a' };
  // The handler takes Ctrl or ⌘ alike for these.
  document.body.dispatchEvent(new KeyboardEvent('keydown', { ...chord, ctrlKey: true, bubbles: true, cancelable: true }));
}
