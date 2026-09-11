import { useEffect, type RefObject } from 'react';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [tabindex="0"]';

/**
 * WAI-ARIA toolbar keyboard behaviour for a contextual popover: once focus is inside the popover,
 * ArrowLeft/ArrowRight (and ArrowUp/ArrowDown between rows) move it between the controls in DOM
 * order, Home/End jump to the first/last. Nothing here steals focus — a popover never focuses
 * itself on open, so the canvas keeps its shortcuts until the user Tabs into the popover — and an
 * open dropdown (`InspectorSelect`'s own listbox) or a text input keeps its own arrow keys.
 *
 * Shared by `ElementInspectorPopover` and `EdgeInspectorPopover` so the two toolbars can't drift
 * apart in how they respond to the keyboard.
 */
export function usePopoverKeyboard(rootRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      if (!target) return;
      // A dropdown's listbox and a text field own their own arrow keys.
      if (target.closest('[role="listbox"]') || target.tagName === 'INPUT') return;
      const controls = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) => !element.closest('[role="listbox"]') && element.offsetParent !== null,
      );
      if (controls.length === 0) return;
      const index = controls.indexOf(target);
      if (index < 0) return;
      let next: number | null = null;
      switch (event.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          next = (index + 1) % controls.length;
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          next = (index - 1 + controls.length) % controls.length;
          break;
        case 'Home':
          next = 0;
          break;
        case 'End':
          next = controls.length - 1;
          break;
        default:
          return;
      }
      event.preventDefault();
      event.stopPropagation();
      controls[next]?.focus();
    };
    root.addEventListener('keydown', onKeyDown);
    return () => root.removeEventListener('keydown', onKeyDown);
    // No dependency list on purpose: the root element only exists once the popover has mounted
    // (both popovers render `null` until then), so the first render sees a null ref. Re-binding
    // one listener per render is cheap.
  });
}
