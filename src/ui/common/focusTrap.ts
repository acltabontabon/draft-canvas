/**
 * The Tab-trap shared by every surface that holds focus while it's up — `Modal`, and Learn when it
 * covers the canvas as a sheet on a narrow window.
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
  if (event.shiftKey && (document.activeElement === first || atRoot)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || atRoot)) {
    event.preventDefault();
    first.focus();
  }
}
