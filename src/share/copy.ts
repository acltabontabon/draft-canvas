import type { DraftDocument } from '../document/types';
import { encodeShareLink, type ShareStart } from './link';
import { hostKind } from '../host/hostInfo';
import { PRODUCT } from '../product';
import { checkShareCancelled, type ShareOptions } from './compress';

export const SHARE_LINK_COPIED = 'Link copied — anyone with it can read this diagram.';

/** What a diagram past the cap is told, with how big its link would have been. */
export function tooLargeMessage(bytes: number): string {
  return `This diagram is too big for a link (${Math.ceil(bytes / 1024)} KB). Export the file instead.`;
}

/** Copy an already generated link directly from a click, before browser user activation expires. */
export async function copyPreparedShareLink(
  url: string,
  notify: (message: string, tone?: 'info' | 'error') => void,
  protectedLink = false,
): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(url);
    notify(protectedLink ? 'Protected link copied. Send the passphrase separately.' : SHARE_LINK_COPIED);
    return true;
  } catch {
    return false;
  }
}

/**
 * Builds the link for `file` (the whole document, every room) and puts it on the clipboard. Where
 * the clipboard can't be written — no permission, an insecure origin, a browser without the API —
 * the link stays available through `onReady`, or a prompt for callers without their own UI.
 */
export async function copyShareLink(
  file: DraftDocument,
  notify: (message: string, tone?: 'info' | 'error') => void,
  start?: ShareStart,
  passphrase?: string,
  onReady?: (url: string) => void,
  options: ShareOptions = {},
): Promise<boolean> {
  let result: Awaited<ReturnType<typeof encodeShareLink>>;
  try {
    result = await encodeShareLink(file, hostKind() ? PRODUCT.web.app : undefined, start, passphrase, options);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return false;
    notify('A share link could not be made on this device. Export the file instead.', 'error');
    return false;
  }
  if ('tooLarge' in result) {
    notify(tooLargeMessage(result.bytes), 'error');
    return false;
  }
  // A successful write is not a way to retrieve the link: embedded browsers can isolate their
  // clipboard from the host. Always expose it so opening and manual copying remain available.
  onReady?.(result.url);
  checkShareCancelled(options.signal);
  options.onProgress?.('copying');
  if (await copyPreparedShareLink(result.url, notify, passphrase !== undefined)) return true;
  if (!onReady) {
    // The one place a prompt is the right tool: it is the only built-in that hands over a string
    // ready to select and copy when the clipboard API itself refused.
    window.prompt(passphrase === undefined ? 'Copy this link — anyone with it can read this diagram:' : 'Copy this protected link. Send the passphrase separately:', result.url);
  }
  return false;
}
