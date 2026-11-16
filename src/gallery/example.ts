import { parseDocument } from '../document/validate';
import type { DraftDocument } from '../document/types';
import { canvasFromFile } from './canvas';
import exampleFile from './example/order-processing.draftcanvas?raw';

/**
 * "Try an example": a small worked diagram that ships with the app, so it opens offline and on
 * first run, before anyone has chosen to load the starters gallery. The same file is the gallery's
 * `examples/order-processing`; `tests/starter-files.test.ts` checks this copy like any starter.
 */
export const EXAMPLE_TITLE = 'Order processing';

export function exampleFileDocument(): DraftDocument {
  const parsed = parseDocument(exampleFile);
  if (!parsed.ok) throw new Error(`The bundled example does not open: ${parsed.error}`);
  return parsed.document;
}

/** A new canvas holding the example. */
export function exampleCanvas(): DraftDocument {
  return canvasFromFile(exampleFileDocument(), EXAMPLE_TITLE);
}
