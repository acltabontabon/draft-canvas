import type { DraftDocument } from '../../document/types';
import { count } from '../../lib/plural';
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

export { fixesNote } from '../../lib/arrangeFixes';

/** How many shapes the arrangement shown moves, for the bar: "Moves 12 shapes". Empty when none do. */
export function movesNote(base: DraftDocument, view: DraftDocument): string {
  const was = new Map(base.nodes.map((node) => [node.id, node]));
  let moved = 0;
  for (const node of view.nodes) {
    const old = was.get(node.id);
    if (old && (old.x !== node.x || old.y !== node.y)) moved += 1;
  }
  return moved > 0 ? `Moves ${count(moved, 'shape')}` : '';
}

/** What a preview did not do, or leaves as it is, one line each — in the words the bar says under its name. */
export function layoutNotes(preview: Pick<ArrangePreview, 'partial' | 'alternativeSkipped' | 'sketches' | 'scoped'>, kind: 'arrange' | 'tidy'): string[] {
  const notes: string[] = [];
  if (preview.partial) {
    notes.push(kind === 'tidy'
      ? 'Stopped early on a large diagram. Apply it, then run Tidy up again to continue.'
      : 'Stopped early on a large diagram. Apply it, then run Tidy up to finish the connectors.');
  }
  if (kind === 'arrange' && preview.alternativeSkipped) notes.push('Only one direction was worked out for a diagram this size.');
  if (preview.sketches) notes.push(preview.sketches === 1 ? '1 sketch stays where it is.' : `${preview.sketches} sketches stay where they are.`);
  return notes;
}
