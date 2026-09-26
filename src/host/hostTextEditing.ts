import { isEditableTarget, isInOwnKeyboardRegion, isTextChord } from '../lib/isEditableTarget';
import { isCommandChord } from '../lib/platform';
import type { HostClipboard } from './hostClipboard';

type TextField = HTMLInputElement | HTMLTextAreaElement;

/** A field whose text can be selected, copied and replaced — not a select, a number box or a slider. */
function textFieldOf(target: EventTarget | null): TextField | null {
  if (target instanceof HTMLTextAreaElement) return target;
  if (target instanceof HTMLInputElement && typeof target.selectionStart === 'number') return target;
  return null;
}

function selectedTextOf(field: TextField | null): string {
  if (field) return field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0);
  return window.getSelection()?.toString() ?? '';
}

/**
 * Select All, Copy, Cut, Paste and Undo for a text the app shows — a field being typed in, or plain
 * text being read (a panel, a dialog).
 *
 * Framed by a host, a key pressed here never becomes the host's Edit-menu action, so none of these
 * did anything (see `LoadMessage.textEditing`). The frame's own document can do all of it except the
 * clipboard, which goes through the host. Returns whether the key was handled; the caller then keeps it
 * from anything else.
 */
export function handleTextChord(event: KeyboardEvent, clipboard: HostClipboard): boolean {
  if (event.isComposing || event.altKey || !isCommandChord(event)) return false;
  const key = event.key.toLowerCase();
  const editable = isEditableTarget(event.target);
  const field = textFieldOf(event.target);
  const editableText = editable && (field !== null || (event.target as HTMLElement).isContentEditable);
  const secret = field?.type === 'password';

  if (editableText) {
    const readOnly = field?.readOnly === true || field?.disabled === true;
    switch (key) {
      case 'a':
        if (event.shiftKey) return false;
        if (field) field.select();
        else document.execCommand('selectAll');
        return true;
      case 'c':
      case 'x': {
        if (event.shiftKey || secret) return false;
        const text = selectedTextOf(field);
        if (text) {
          clipboard.write(text, true);
          if (key === 'x' && !readOnly) document.execCommand('delete');
        }
        return true;
      }
      case 'v': {
        if (event.shiftKey || readOnly) return false;
        const target = event.target;
        void clipboard.read(true).then((text) => {
          // The read is async: nothing lands if focus has moved on meanwhile.
          if (text && document.activeElement === target) document.execCommand('insertText', false, text);
        });
        return true;
      }
      case 'z':
      case 'y':
        if (readOnly || (key === 'y' && event.shiftKey)) return false;
        document.execCommand(key === 'y' || event.shiftKey ? 'redo' : 'undo');
        return true;
      default:
        return false;
    }
  }

  if (editable || event.shiftKey || (key !== 'c' && key !== 'a')) return false;
  // Plain text on the page. Only a keyboard region's own text and what's selected in a dialog count: with
  // anything else the chord is the canvas's (copy the selected shapes).
  const region = event.target instanceof Element ? event.target.closest('[data-dc-keyboard-region]') : null;
  if (key === 'a') {
    if (!region || !isInOwnKeyboardRegion(event.target)) return false;
    window.getSelection()?.selectAllChildren(region);
    return true;
  }
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return false;
  const inDialog = selection.anchorNode?.parentElement?.closest('[aria-modal="true"]') != null;
  if (!inDialog && !isTextChord(event)) return false;
  clipboard.write(selection.toString(), true);
  return true;
}
