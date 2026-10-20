import type { ReactNode } from 'react';
import './living-canvas.css';

/** The desktop's clickable diagram. Actions stay with the host; this scene only arranges them. */
export function LivingCanvas({ start, example, open, companion }: {
  start: ReactNode;
  example: ReactNode;
  open: ReactNode;
  companion?: ReactNode;
}) {
  return (
    <section className="dc-living" aria-label="Start drawing">
      <header className="dc-living-heading">
        <p className="dc-living-eyebrow">Good ideas need a little space</p>
        <h2>It starts with <em>a thought.</em></h2>
        <p className="dc-living-subtitle">Give it a shape. See where it goes.</p>
      </header>
      <div className="dc-living-map">
        <svg className="dc-living-wires" viewBox="0 0 810 270" preserveAspectRatio="none" aria-hidden="true" focusable="false">
          <path d="M231 67H247Q269 67 269 90V124H280M535 122H559Q578 122 578 102V74H642" />
          {companion && <path d="M535 150H564Q580 150 580 173V214H626" />}
          <circle cx="280" cy="124" r="3" />
          <circle cx="535" cy="122" r="3" />
          {companion && <circle cx="535" cy="150" r="3" />}
        </svg>
        <div className="dc-living-start">{start}</div>
        <div className="dc-living-example dc-living-satellite">{example}</div>
        <div className="dc-living-open dc-living-satellite">{open}</div>
        <p className="dc-living-note">a blank canvas, a fresh perspective</p>
        {companion && <div className="dc-living-companion dc-living-satellite">{companion}</div>}
      </div>
    </section>
  );
}
