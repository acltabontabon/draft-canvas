/**
 * The Tab-trap shared by every surface that holds focus while it's up — `Modal`, and any sheet that
 * covers the canvas on a narrow window.
 */

/** Elements a Tab-trap should stop at — mirrors what these surfaces actually contain (buttons,
 *  inputs, selects, links); disabled controls are filtered out since they can't take focus. */
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Reachable by Tab: not inside a hidden/inert subtree, and not an unchecked radio whose group has a
 *  checked one (the browser Tabs only to a group's checked member). */
function isTabbable(element: HTMLElement): boolean {
  if (element.closest('[hidden], [inert]')) return false;
  if (element instanceof HTMLInputElement && element.type === 'radio' && !element.checked && element.name) {
    const group = Array.from(element.ownerDocument.getElementsByName(element.name));
    if (group.some((member) => member instanceof HTMLInputElement && member.checked)) return false;
  }
  return true;
}

/**
 * Keeps a Tab keypress inside `root`, wrapping at either end rather than blocking Tab outright. Call
 * from a keydown handler; does nothing for any other key.
 *
 * Every step is taken here, not only the wrap at the ends. Safari, by default, Tabs only between
 * text fields and skips buttons — so a trap that let the browser take the middle steps lost focus
 * out of the dialog the moment the next text field in document order was behind it (Shift+Tab from
 * the shortcut sheet's search box landed in the diagram title). Inside a dialog every control is one
 * Tab away, in every browser.
 */
export function trapTab(event: KeyboardEvent, root: HTMLElement): void {
  if (event.key !== 'Tab') return;
  const focusable = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isTabbable);
  if (focusable.length === 0) return;
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  // Focus already outside — the control that held it unmounted (a step change), leaving it on
  // the page. The next Tab would walk into whatever sits behind.
  if (!root.contains(document.activeElement)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
    return;
  }
  // A surface may focus its own root first (so a screen reader announces its label before any one
  // control) — so "at the boundary" also means "focus hasn't left the root yet".
  const atRoot = document.activeElement === root;
  if (atRoot) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
    return;
  }
  const index = focusable.indexOf(document.activeElement as HTMLElement);
  // Focus on something the list doesn't name (a control inside a widget that manages its own
  // focus): only the wrap is ours, the step is the browser's.
  if (index === -1) return;
  event.preventDefault();
  const next = event.shiftKey ? (index === 0 ? last : focusable[index - 1]!) : index === focusable.length - 1 ? first : focusable[index + 1]!;
  next.focus();
}
