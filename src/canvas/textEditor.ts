import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  continueOnEnter,
  indentLines,
  insertLink,
  toggleInline,
  toggleLines,
  type InlineFormat,
  type LineFormat,
  type SourceEdit,
  type SourceSelection,
} from './markdownEditing';

/**
 * The Text element's open editor. One at a time — a node's editor registers itself while it is
 * mounted — so the format bar, which lives in the element's popover rather than in the node, can
 * reach it without a ref threaded through React Flow.
 */
export const activeTextEditor: { current: HTMLTextAreaElement | null } = { current: null };

export function selectionOf(textarea: HTMLTextAreaElement): SourceSelection {
  return { value: textarea.value, start: textarea.selectionStart, end: textarea.selectionEnd };
}

/**
 * Applies an edit as typing would: through the browser's own insertion, so ⌘Z inside the editor
 * undoes a format the same way it undoes a keystroke, and `input` fires for the editor's auto-grow.
 */
export function applySourceEdit(textarea: HTMLTextAreaElement, edit: SourceEdit): void {
  textarea.focus();
  textarea.setSelectionRange(edit.from, edit.to);
  const before = textarea.value;
  let inserted = false;
  try {
    inserted =
      edit.insert === ''
        ? edit.from === edit.to || window.document.execCommand('delete')
        : window.document.execCommand('insertText', false, edit.insert);
  } catch {
    inserted = false;
  }
  const expected = before.slice(0, edit.from) + edit.insert + before.slice(edit.to);
  if (!inserted || textarea.value !== expected) {
    textarea.value = expected;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }
  textarea.setSelectionRange(edit.start, edit.end);
}

const INLINE_KEYS: Record<string, InlineFormat> = { b: 'bold', i: 'italic', e: 'code' };
const SHIFT_INLINE_KEYS: Record<string, InlineFormat> = { x: 'strike', h: 'highlight' };
const LINE_KEYS: Record<string, LineFormat> = { '7': 'number', '8': 'bullet', '9': 'task' };
const HEADING_KEYS: Record<string, LineFormat> = { '1': 'h1', '2': 'h2', '3': 'h3' };

/**
 * A Text editor's Markdown keys: the format shortcuts, list continuation on Enter, Tab to nest.
 * `true` when the key was handled. Bold and italic with nothing selected are left to the caller —
 * they keep toggling the whole element, as they always have.
 */
export function handleMarkdownKey(event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean {
  const textarea = event.currentTarget;
  const selection = selectionOf(textarea);
  const mod = event.metaKey || event.ctrlKey;
  // `event.code` for the digits: Shift turns `8` into `*` (and `7` into `&`) on most layouts.
  const digit = /^Digit(\d)$/.exec(event.code)?.[1];
  let edit: SourceEdit | null = null;

  if (mod && !event.altKey && !event.shiftKey && INLINE_KEYS[event.key.toLowerCase()]) {
    const format = INLINE_KEYS[event.key.toLowerCase()]!;
    if (format !== 'code' && selection.start === selection.end) return false;
    edit = toggleInline(selection, format);
  } else if (mod && event.shiftKey && !event.altKey && SHIFT_INLINE_KEYS[event.key.toLowerCase()]) {
    edit = toggleInline(selection, SHIFT_INLINE_KEYS[event.key.toLowerCase()]!);
  } else if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k') {
    edit = insertLink(selection);
  } else if (mod && event.shiftKey && !event.altKey && digit && LINE_KEYS[digit]) {
    edit = toggleLines(selection, LINE_KEYS[digit]!);
  } else if (mod && event.altKey && digit && HEADING_KEYS[digit]) {
    edit = toggleLines(selection, HEADING_KEYS[digit]!);
  } else if (event.key === 'Tab' && !mod && !event.altKey) {
    edit = indentLines(selection, event.shiftKey);
  } else if (event.key === 'Enter' && !mod && !event.shiftKey && !event.altKey) {
    edit = continueOnEnter(selection);
  }
  if (!edit) return false;
  event.preventDefault();
  applySourceEdit(textarea, edit);
  return true;
}
