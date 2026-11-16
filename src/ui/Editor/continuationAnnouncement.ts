import type { UiStore } from '../../store/uiStore';

/**
 * What a screen reader is told about the suggestion on screen — its name, the authored reason it is
 * on offer, and the keys that act on it; or the line `]` had to say when there was nothing to step
 * to; or nothing, while no suggestion is showing.
 */
export function continuationAnnouncement(state: Pick<UiStore, 'continuation' | 'continuationNotice'>): string {
  if (state.continuationNotice) return state.continuationNotice;
  const offer = state.continuation;
  if (offer?.trigger !== 'select') return '';
  const ids = offer.alternatives ?? [];
  const why = offer.reason ? ` ${offer.reason}` : '';
  if (ids.length < 2) return `Suggested: ${offer.label}.${why} Press Tab to add it, or Escape to dismiss.`;
  const position = `${ids.indexOf(offer.id) + 1} of ${ids.length}`;
  return `Suggested: ${offer.label}, ${position}.${why} Press Tab to add it, ] for the next, or Escape to dismiss.`;
}
