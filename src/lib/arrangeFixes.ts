/** One thing an arrangement fixes: the kind, and the shape, connector or boundary (none for `sparse`).
 *  The kinds are `agent/proportion.ts`'s. */
export interface ArrangeFix {
  kind: 'stacked-name' | 'hidden-caption' | 'heavy-header' | 'sparse';
  id: string;
}

const FIX_WORDS: Record<ArrangeFix['kind'], [one: string, many: string]> = {
  'stacked-name': ['stacked name', 'stacked names'],
  'hidden-caption': ['cut-off caption', 'cut-off captions'],
  'heavy-header': ['top-heavy boundary', 'top-heavy boundaries'],
  // About the whole view, so never counted: one phrase that says what is wrong with it.
  sparse: ['an overview too small to read', 'an overview too small to read'],
};

/** What is fixed, counted in words: "2 stacked names, 1 cut-off caption". Empty for nothing. */
export function fixesList(fixes: readonly ArrangeFix[] | undefined): string {
  if (!fixes?.length) return '';
  const parts: string[] = [];
  for (const kind of Object.keys(FIX_WORDS) as ArrangeFix['kind'][]) {
    const count = fixes.filter((fix) => fix.kind === kind).length;
    if (!count) continue;
    const [one, many] = FIX_WORDS[kind];
    parts.push(kind === 'sparse' ? one : `${count} ${count === 1 ? one : many}`);
  }
  return parts.join(', ');
}

/** What the arrangement shown fixes, for the Arrange bar: "Fixes 2 stacked names, 1 cut-off caption".
 *  Empty when it fixes none of what is checked, so the bar says nothing rather than "Fixes nothing". */
export function fixesNote(fixes: readonly ArrangeFix[] | undefined): string {
  const list = fixesList(fixes);
  return list ? `Fixes ${list}` : '';
}
