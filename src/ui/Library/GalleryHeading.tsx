import type { ReactNode } from 'react';
import './gallery.css';

/** Shared library hierarchy; file actions and storage remain with each host. */
export function GalleryHeading({ action }: { action: ReactNode }) {
  return (
    <div className="dc-gallery-heading">
      <div>
        <p className="dc-gallery-eyebrow">Your library</p>
        <h2>Thoughts <em>worth keeping.</em></h2>
        <p className="dc-gallery-subtitle">A little collection of things you made clearer.</p>
      </div>
      {action}
    </div>
  );
}
