import type { ArrangeDirection, ArrangePreview } from '../../store/uiStore';

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
