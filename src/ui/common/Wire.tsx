import type { WireGeometry } from './wireGeometry';

/** Where the wire's arrowheads stop short of a target, and how far out the spine sits. */
const TICK = 22;

/**
 * A connector drawn between two parts of a layout: a trunk out of the source's middle, a spine
 * down the far edge, one arrowed branch into each target — the same fan-out shape Smart Routing
 * draws on the canvas.
 *
 * Shared by the home screen (blank canvas → starter categories) and the editor's empty canvas
 * (start block → starter rows), because the two screens are telling the same story and a second
 * drawing of it would drift. The only thing it needs from layout is where the source's middle and
 * each target actually landed, so it measures them (one ResizeObserver, nothing on scroll or
 * pointer) rather than guessing: any split, any count.
 */
export function Wire({ geometry, caption }: { geometry: WireGeometry; caption?: string }) {
  const { width, height, trunkY, labelYs } = geometry;
  const spineX = width - TICK;
  const top = Math.min(trunkY, ...labelYs);
  const bottom = Math.max(trunkY, ...labelYs);
  const tipX = width - 5;
  return (
    <>
      <svg className="dc-wire" width={width} height={height} viewBox={`0 0 ${width} ${height}`} focusable="false">
        <path className="dc-wire-trunk" d={`M0 ${trunkY}H${spineX}`} pathLength={1} />
        {bottom - top > 1 && <path className="dc-wire-spine" d={`M${spineX} ${top}V${bottom}`} pathLength={1} />}
        {labelYs.map((y, i) => (
          <g key={i} className="dc-wire-branch">
            <path d={`M${spineX} ${y}H${tipX}`} pathLength={1} />
            <path className="dc-wire-arrow" d={`M${tipX - 4} ${y - 3}L${tipX} ${y}L${tipX - 4} ${y + 3}`} />
          </g>
        ))}
        <circle className="dc-wire-source" cx={3.5} cy={trunkY} r={3} />
        <circle className="dc-wire-junction" cx={spineX} cy={trunkY} r={2.5} />
      </svg>
      {caption && (
        <span className="dc-wire-caption" style={{ left: spineX / 2, top: trunkY }}>
          {caption}
        </span>
      )}
    </>
  );
}
