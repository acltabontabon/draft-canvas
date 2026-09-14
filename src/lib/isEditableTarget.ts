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
  if (target instanceof HTMLInputElement) return !NON_TEXT_INPUT_TYPES.has(target.type);
  return target.isContentEditable || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
}

/** Inputs nobody types into. A focused checkbox (Chrome focuses one when its label is clicked) must
 *  not switch every editor shortcut off the way a text field rightly does. (Range and radio inputs stay
 *  editable: their arrow keys are their own.) */
const NON_TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  'checkbox',
  'color',
  'button',
  'submit',
  'reset',
  'file',
  'image',
]);

const CONTROL_SELECTOR =
  'button, a[href], summary, input[type="checkbox"], [role="button"], [role="link"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], [role="tab"], [role="radio"], [role="checkbox"], [role="switch"], [role="slider"]';

/**
 * Whether an event's target is a control that Enter/Space activate on their own. A global
 * shortcut claiming those keys (and calling `preventDefault`) would cancel the click the user
 * meant — Enter on a focused inspector button starting a text edit instead, Space on a focused
 * "Previous" advancing the presentation.
 */
export function isActivatableTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(CONTROL_SELECTOR) !== null;
}

/**
 * Whether an event's target sits inside a surface that owns its own keys while it has focus — the
 * Learn drawer, docked beside a canvas that is still live. The editor's bare-key shortcuts (a
 * letter drops a shape, Backspace deletes, Escape deselects) stand down there; its ⌘ chords don't.
 * Mark such a surface with `data-dc-keyboard-region`.
 */
export function isInOwnKeyboardRegion(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-dc-keyboard-region]') !== null;
}

/**
 * Whether something that stacks above the canvas's own popovers is open — a modal, the command
 * palette, or a menu. Those popovers listen for Escape on `window` in the capture phase, and
 * `stopPropagation` can't stop a sibling listener on that same target, so without this one Escape in
 * ⌘K closed the palette and the attachment card behind it together.
 */
export function overlayAboveCanvasIsOpen(): boolean {
  return document.querySelector('[aria-modal="true"]:not(.dc-learn), [role="menu"]') !== null;
}

/** An Enter/Escape that is part of an IME composition (confirming or cancelling a conversion). */
export function isImeKeyEvent(event: { isComposing?: boolean; keyCode?: number; nativeEvent?: { isComposing?: boolean } }): boolean {
  return event.isComposing === true || event.nativeEvent?.isComposing === true || event.keyCode === 229;
}
