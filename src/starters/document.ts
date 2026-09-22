import { createDocument } from '../document/factory';
import { freeOriginFor, openingViewportFor } from '../document/geometry';
import type { DraftDocument } from '../document/types';
import { buildStarter, starterSize } from './build';
import type { ArchitectureStarter } from './types';

/**
 * A new document already holding `starter`: what the web Library's starters and the desktop's
 * Quick Draft from a starter both create, so the two can't drift.
 *
 * The starter is the canvas's initial state, not an edit: there is nothing to undo, exactly as with
 * an imported file. Same origin the palette uses for an empty canvas, plus a viewport that shows it
 * — see `openingViewportFor` for why the editor won't do that itself.
 */
export function starterDocument(starter: ArchitectureStarter, title = starter.name): DraftDocument {
  const document = createDocument(title);
  const size = starterSize(starter);
  const { nodes, edges, flows } = buildStarter(starter, freeOriginFor(document, size));
  const screen = typeof window === 'undefined' ? null : { width: window.innerWidth, height: window.innerHeight };
  return { ...document, nodes, edges, flows, ...(screen ? { viewport: openingViewportFor(size, screen) } : {}) };
}
