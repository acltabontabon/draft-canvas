import { useEffect, useState } from 'react';

/**
 * The editor toolbar's height, kept current with a `ResizeObserver` while `active`. The anchored
 * popovers follow the viewport and re-render on every pan frame; reading layout during each of
 * those renders for a value that only changes when the toolbar wraps would force a layout per frame.
 */
export function useToolbarHeight(active: boolean): number | undefined {
  const [height, setHeight] = useState<number>();
  useEffect(() => {
    if (!active) return;
    const toolbar = window.document.querySelector('.dc-toolbar');
    if (!toolbar) return;
    const measure = () => setHeight(Math.round(toolbar.getBoundingClientRect().height));
    if (typeof ResizeObserver === 'undefined') {
      measure();
      return;
    }
    // The observer reports the size once on `observe` and again on every change, from layout the
    // browser has already done: measuring here as well forced a layout on every popover mount —
    // that is, on every click that selects something.
    const observer = new ResizeObserver(([entry]) => {
      const box = entry?.borderBoxSize?.[0];
      if (box) setHeight(Math.round(box.blockSize));
      else measure();
    });
    observer.observe(toolbar);
    return () => observer.disconnect();
  }, [active]);
  return height;
}
