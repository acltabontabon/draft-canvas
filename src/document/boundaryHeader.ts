/**
 * The row a boundary's title and kind mark sit in, measured from the outline's top edge. Drawn by
 * `nodes/describe.ts`; lives in `document/` because placement needs the same number — a shape set
 * down inside a boundary should stay below its title (`continuation/materialize.ts`), and
 * `describe.ts` is not somewhere the document layer can read from.
 */
export const BOUNDARY_HEADER_HEIGHT = 32;

/** From a boundary box's own top to the bottom of its header row (the outline is the first pixel). */
export const BOUNDARY_HEADER_BAND = 1 + BOUNDARY_HEADER_HEIGHT;
