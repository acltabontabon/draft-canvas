import { useEffect, useRef } from 'react';
import { motionMs } from '../../lib/motion';
import { useUiStore } from '../../store/uiStore';

/**
 * The shape opening into a room — one sheet, growing from the shape's own rectangle to fill the
 * canvas (and shrinking back into it on the way out).
 *
 * It is a picture of a move that has already happened: the editor is showing the new room before
 * this mounts, nothing waits on it, and a second navigation simply replaces the token mid-flight.
 * Under reduced motion no token is ever set, so this renders nothing at all.
 */
export function DepthTransition() {
  const transition = useUiStore((state) => state.depthTransition);
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sheet = sheetRef.current;
    if (!transition || !sheet) return;
    const canvas = sheet.parentElement?.getBoundingClientRect();
    const duration = motionMs(260);
    if (!canvas || canvas.width === 0 || duration === 0) {
      useUiStore.getState().setDepthTransition(null);
      return;
    }

    // The shape's rectangle, expressed as what the canvas-sized sheet has to be scaled and moved
    // to in order to sit exactly on top of it.
    const { from } = transition;
    const scaleX = Math.max(from.width / canvas.width, 0.02);
    const scaleY = Math.max(from.height / canvas.height, 0.02);
    // A centre-origin scale leaves the sheet's left edge inset by half of what it shrank by, so
    // the translation has to account for that to land exactly on the shape.
    const x = from.x - canvas.x - (canvas.width * (1 - scaleX)) / 2;
    const y = from.y - canvas.y - (canvas.height * (1 - scaleY)) / 2;
    const shape = { transform: `translate(${x}px, ${y}px) scale(${scaleX}, ${scaleY})`, opacity: 0.85 };
    const full = { transform: 'translate(0px, 0px) scale(1, 1)', opacity: 0 };

    const animation = sheet.animate(transition.direction === 'in' ? [shape, full] : [full, shape], {
      duration,
      easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
      fill: 'forwards',
    });
    const done = () => useUiStore.getState().setDepthTransition(null);
    animation.addEventListener('finish', done);
    return () => {
      animation.removeEventListener('finish', done);
      animation.cancel();
    };
  }, [transition]);

  if (!transition) return null;
  return <div className="dc-depth-sheet" ref={sheetRef} aria-hidden="true" />;
}
