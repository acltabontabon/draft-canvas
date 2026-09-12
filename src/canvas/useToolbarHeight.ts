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
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(toolbar);
    return () => observer.disconnect();
  }, [active]);
  return height;
}
