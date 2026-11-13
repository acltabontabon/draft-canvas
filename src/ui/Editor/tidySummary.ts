import { count } from '../../lib/plural';
import type { TidyPreview } from '../../store/uiStore';

/** What the preview changes, in the words the bar says and a screen reader hears. */
export function tidySummary(preview: Pick<TidyPreview, 'moved' | 'reattached'>): string {
  const parts: string[] = [];
  if (preview.moved > 0) parts.push(`${count(preview.moved, 'shape')} nudged`);
  if (preview.reattached > 0) parts.push(`${count(preview.reattached, 'connector')} re-attached`);
  return parts.join(', ');
}
