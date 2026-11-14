import type { ArrangeDirection, ArrangeFix, ArrangePreview } from '../../store/uiStore';

/** The one direction an Arrange preview offers, in the words the bar says. */
export function readsAs(direction: ArrangeDirection): string {
  return direction === 'right' ? 'reads left to right' : 'reads top to bottom';
}

/** Beside the direction choice, always a word, so the bar keeps its width as the choice changes:
 *  whether the one shown is the suggested one, or the way the diagram reads now, or a turn. */
export function directionNote(preview: Pick<ArrangePreview, 'direction' | 'suggested' | 'current'>): string {
  if (preview.direction === preview.suggested) return 'Suggested';
  return preview.direction === preview.current ? 'As it reads now' : 'Turned';
}

const FIX_WORDS: Record<ArrangeFix['kind'], [one: string, many: string]> = {
  'stacked-name': ['stacked name', 'stacked names'],
  'hidden-caption': ['cut-off caption', 'cut-off captions'],
  'heavy-header': ['top-heavy boundary', 'top-heavy boundaries'],
  sparse: ['small overview', 'small overview'],
};

/** What the arrangement shown fixes, for the bar: "Fixes 2 stacked names, 1 cut-off caption". Empty
 *  when it fixes none of what is checked, so the bar says nothing rather than "Fixes nothing". */
export function fixesNote(fixes: readonly ArrangeFix[] | undefined): string {
  if (!fixes?.length) return '';
  const parts: string[] = [];
  for (const kind of Object.keys(FIX_WORDS) as ArrangeFix['kind'][]) {
    const count = fixes.filter((fix) => fix.kind === kind).length;
    if (!count) continue;
    const [one, many] = FIX_WORDS[kind];
    parts.push(kind === 'sparse' ? `a ${one}` : `${count} ${count === 1 ? one : many}`);
  }
  return `Fixes ${parts.join(', ')}`;
}
