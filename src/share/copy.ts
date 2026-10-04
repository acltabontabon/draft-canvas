import type { DraftDocument } from '../document/types';
import { encodeShareLink, type ShareStart } from './link';

export const SHARE_LINK_COPIED = 'Link copied — anyone with it can read this diagram.';

/** What a diagram past the cap is told, with how big its link would have been. */
export function tooLargeMessage(bytes: number): string {
  return `This diagram is too big for a link (${Math.ceil(bytes / 1024)} KB). Export the file instead.`;
}

/**
 * Builds the link for `file` (the whole document, every room) and puts it on the clipboard. Where
 * the clipboard can't be written — no permission, an insecure origin, a browser without the API —
 * the link is shown in a prompt so it can still be copied by hand.
 */
export async function copyShareLink(
  file: DraftDocument,
  notify: (message: string, tone?: 'info' | 'error') => void,
  start?: ShareStart,
): Promise<void> {
  let result: Awaited<ReturnType<typeof encodeShareLink>>;
  try {
    result = await encodeShareLink(file, undefined, start);
  } catch {
    notify('A share link could not be made in this browser. Export the file instead.', 'error');
    return;
  }
  if ('tooLarge' in result) {
    notify(tooLargeMessage(result.bytes), 'error');
    return;
  }
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(result.url);
    notify(SHARE_LINK_COPIED);
  } catch {
    // The one place a prompt is the right tool: it is the only built-in that hands over a string
    // ready to select and copy when the clipboard API itself refused.
    window.prompt('Copy this link — anyone with it can read this diagram:', result.url);
  }
}
