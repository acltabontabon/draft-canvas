/**
 * Whether an event's target is a text-editing surface that should keep owning the keyboard/native
 * context menu — a node's inline text editor, an edge label input, a popover field, the command
 * palette's search box. Every such surface in this app is a plain `<textarea>`/`<input>`, never
 * `contentEditable`-as-set, but the property is still checked for any future surface that might use
 * it. Shared by `EditorScreen.tsx`'s keyboard guard and `Canvas.tsx`'s right-click handlers so the
 * two can never drift on what counts as "typing into a field."
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}
