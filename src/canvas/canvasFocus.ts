import { useLayoutEffect, type RefObject } from 'react';

/** The canvas itself (`.dc-canvas`): the diagram's one Tab stop, and where keyboard focus goes back
 *  to when something that held it on the canvas's behalf goes away. */
export function focusCanvas(): void {
  document.querySelector<HTMLElement>('.dc-canvas')?.focus({ preventScroll: true });
}

/**
 * Hands focus back to the canvas when `surface` holds it, or when it has already fallen to the page
 * (`<body>`, where a removed element leaves it). A control elsewhere that has focus took it on
 * purpose, and keeps it.
 */
export function returnFocusToCanvas(surface: Element | null): void {
  const active = document.activeElement;
  if (active === null || active === document.body || (surface?.contains(active) ?? false)) focusCanvas();
}

/**
 * For a canvas toolbar that goes when its selection does: Escape inside it, its own Delete, a key
 * that moves the selection on. Focus inside it fell to `<body>`, where a screen reader lost its place
 * and the next Tab skipped the canvas. It goes back to the canvas as the toolbar starts to close (it
 * stays mounted, faded, for its exit), or as it unmounts without one — where the context menu's own
 * Delete already leaves it.
 */
export function useCanvasFocusReturn(rootRef: RefObject<HTMLElement | null>, closing: boolean): void {
  useLayoutEffect(() => {
    if (closing) returnFocusToCanvas(rootRef.current);
  }, [closing, rootRef]);
  // A deletion runs this before React removes the toolbar or lets go of its ref, so the ref still
  // holds the element focus may be in.
  useLayoutEffect(() => () => returnFocusToCanvas(rootRef.current), [rootRef]);
}
