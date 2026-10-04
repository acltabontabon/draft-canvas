import { SHARE_PARAM, SHARE_START_PARAM, sharePayloadFromHash } from './link';

/**
 * Drops the share payload from the address once the shared diagram has been closed or copied into
 * the library — a refresh should then land where the screen is, not reopen the shared copy. Replaces
 * rather than pushes: the shared diagram never added a history entry of its own, so there is
 * nothing for Back to step over.
 */
export function clearShareFragment(): void {
  if (typeof window === 'undefined' || sharePayloadFromHash(window.location.hash) === null) return;
  const url = new URL(window.location.href);
  const params = new URLSearchParams(url.hash.replace(/^#/, ''));
  params.delete(SHARE_PARAM);
  params.delete(SHARE_START_PARAM);
  const hash = params.toString();
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${hash ? `#${hash}` : ''}`);
}
