import type { ReactNode } from 'react';
import { InkedWords } from './InkedWords';
import './web-home.css';

/** A browser sketchbook: the invitation and the three ways into a local canvas. */
export function WebHomeScene({ start, example, importFile }: {
  start: ReactNode;
  example: ReactNode;
  importFile: ReactNode;
}) {
  return (
    <section className="dc-web-scene" aria-label="Start drawing">
      <div className="dc-web-intro">
        <p className="dc-web-eyebrow">Room to think</p>
        <h2>A little space.<br /><em>A <InkedWords>clearer picture</InkedWords>.</em></h2>
        <p className="dc-web-subtitle">Start with a thought. Make it a diagram.</p>
      </div>
      <div className="dc-web-workbench">
        {start}
        <div className="dc-web-alternatives">{example}{importFile}</div>
      </div>
    </section>
  );
}
