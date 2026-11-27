/**
 * How focus came to the element that holds it: put there by a pointer (a button clicked with the
 * mouse, a pen or a finger), or by the keyboard (Tab, or a script acting on a key, as a popover's
 * Escape hands focus back to the chip that opened it).
 *
 * Decided when focus arrives, never when a key is pressed. `:focus-visible` cannot answer at keydown:
 * Chromium, and so the desktop app's WebView2, marks the focused element `:focus-visible` as soon as
 * any key goes down on it, before the page's own keydown handlers run. Asked there, every button that
 * merely kept focus after a click looked reached from the keyboard: Delete stopped deleting after a
 * click on Zoom in, and S stopped dropping a Service after a click on Service.
 */

/** The last input that could move focus. `null` until there is one: focus nobody placed counts as
 *  the keyboard's, the side on which a bare key does nothing. */
let lastInput: 'pointer' | 'keyboard' | null = null;
/** The element focus last arrived on from a pointer, while it may still hold it. */
let placedByPointer: Element | null = null;
/** What held focus when the window went to the back. The same element getting focus again as the
 *  window comes forward was not placed anew, whatever was pressed before. */
let heldOnBlur: Element | null = null;
let watching = false;

const MODIFIERS: ReadonlySet<string> = new Set(['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'OS', 'CapsLock', 'Fn']);

/** Starts listening, once per page. Focus that arrived before it is counted as the keyboard's. */
export function watchFocusOrigin(): void {
  if (watching || typeof window === 'undefined') return;
  watching = true;
  // Capture, so a handler that stops a press on its way down cannot hide it.
  window.addEventListener(
    'pointerdown',
    () => {
      lastInput = 'pointer';
    },
    true,
  );
  window.addEventListener(
    'keydown',
    (event) => {
      // A modifier on its own, or a chord, is no one moving through controls: Alt+Tab or ⌘Tab away
      // and back must not turn a clicked button into one reached from the keyboard.
      if (event.metaKey || event.ctrlKey || event.altKey || MODIFIERS.has(event.key)) return;
      lastInput = 'keyboard';
    },
    true,
  );
  document.addEventListener(
    'focusin',
    (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const returning = target !== null && target === heldOnBlur;
      heldOnBlur = null;
      if (returning) return;
      placedByPointer = lastInput === 'pointer' ? target : null;
    },
    true,
  );
  // Not in capture: an element's blur does not bubble, so only the window's own reaches this.
  window.addEventListener('blur', () => {
    heldOnBlur = document.activeElement;
  });
}

/** Whether `element` holds focus because a pointer put it there, as far as `watchFocusOrigin` saw. */
export function focusPlacedByPointer(element: Element): boolean {
  return element === placedByPointer;
}
