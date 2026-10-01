/**
 * The ids an SVG's `<defs>` hand out — the shadow filter, an arrowhead per colour, a clip per
 * clipped group, the background pattern — resolve against the whole document the SVG is in, not
 * against the `<svg>` element. Two exported diagrams inlined in one page (a wiki, a README rendered
 * by a site, a slide) therefore fought over `#dc-shadow` and `#dc-arrow-…`, and the second one drew
 * with the first one's colours. Every export scopes its ids with a prefix of its own; the canvas,
 * which owns its page, keeps the plain names.
 *
 * A prefix is chosen from what the export is of, not from a counter, so the same diagram exports
 * the same bytes every time.
 */
let prefix = '';

/** An id, prefixed for the export in progress (or plain, on the canvas). */
export function scopedId(base: string): string {
  return `${prefix}${base}`;
}

/** Ids handed out from here on carry `scope` — sanitised to what an id may hold — until `endIdScope`. */
export function beginIdScope(scope: string): void {
  const clean = scope.replace(/[^a-zA-Z0-9_-]/gu, (char) => `.${char.codePointAt(0)!.toString(36)}.`);
  prefix = clean ? `${clean}-` : '';
}

export function endIdScope(): void {
  prefix = '';
}
