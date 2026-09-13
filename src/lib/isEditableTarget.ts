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

const CONTROL_SELECTOR =
  'button, a[href], summary, [role="button"], [role="link"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], [role="tab"], [role="radio"], [role="checkbox"], [role="switch"], [role="slider"]';

/**
 * Whether an event's target is a control that Enter/Space activate on their own. A global
 * shortcut claiming those keys (and calling `preventDefault`) would cancel the click the user
 * meant — Enter on a focused inspector button starting a text edit instead, Space on a focused
 * "Previous" advancing the presentation.
 */
export function isActivatableTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(CONTROL_SELECTOR) !== null;
}

/** An Enter/Escape that is part of an IME composition (confirming or cancelling a conversion). */
export function isImeKeyEvent(event: { isComposing?: boolean; keyCode?: number; nativeEvent?: { isComposing?: boolean } }): boolean {
  return event.isComposing === true || event.nativeEvent?.isComposing === true || event.keyCode === 229;
}
