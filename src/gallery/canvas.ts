import { createDocument } from '../document/factory';
import { boundsOf, freeOriginFor, openingViewportFor } from '../document/geometry';
import { pasteDocument } from '../document/operations';
import type { DraftDocument } from '../document/types';
import type { GalleryEntry } from './catalog';

/**
 * A new canvas holding `file`'s diagram: its shapes, connectors and flows with fresh ids, centred
 * where an empty canvas puts the first thing inserted, and a viewport that shows it. It is the
 * canvas's initial state, not an edit: nothing to undo.
 */
export function canvasFromFile(file: DraftDocument, title: string): DraftDocument {
  const base = createDocument(title);
  const bounds = boundsOf(file.nodes);
  if (!bounds) return base;
  const size = { width: bounds.width, height: bounds.height };
  const origin = freeOriginFor(base, size);
  const { doc } = pasteDocument(base, file, { x: origin.x - bounds.x, y: origin.y - bounds.y });
  const screen = typeof window === 'undefined' ? null : { width: window.innerWidth, height: window.innerHeight };
  return screen ? { ...doc, viewport: openingViewportFor(size, screen) } : doc;
}

/**
 * A new canvas holding a gallery starter, remembering which starter and version it began as
 * (`metadata.origin`) so the editor can say when that starter is updated.
 */
export function canvasFromStarter(entry: Pick<GalleryEntry, 'id' | 'name' | 'sha256'>, file: DraftDocument, title = entry.name): DraftDocument {
  const canvas = canvasFromFile(file, title);
  return { ...canvas, metadata: { ...canvas.metadata, origin: { starter: entry.id, sha256: entry.sha256 } } };
}
