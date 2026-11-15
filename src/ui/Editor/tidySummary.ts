import { count } from '../../lib/plural';
import type { TidyPreview } from '../../store/uiStore';

/** What the preview changes, in the words the bar says and a screen reader hears. */
export function tidySummary(preview: Pick<TidyPreview, 'moved' | 'reattached'>): string {
  const parts: string[] = [];
  // Said with the reason, since "nudged" alone does not tell what for: a nudge is always a few pixels
  // to straighten a connector, a re-attach always to clear a line drawn through something.
  if (preview.moved > 0) parts.push(`${count(preview.moved, 'shape')} nudged to straighten ${preview.moved === 1 ? 'a connector' : 'connectors'}`);
  if (preview.reattached > 0) parts.push(`${count(preview.reattached, 'connector')} re-attached to clear shapes`);
  return parts.join(', ');
}
