/**
 * The `#join=…` an invite link carries — read here, without the collaboration code, so the address
 * can be checked on every page load for the price of a `URLSearchParams`. Kept in sync with
 * `collab/transport/invite.ts`'s `INVITE_PARAM` by `tests/collab/join-fragment.test.ts`.
 */
export const JOIN_PARAM = 'join';

export function joinPayloadFromHash(hash: string): string | null {
  const payload = new URLSearchParams(hash.replace(/^#/, '')).get(JOIN_PARAM);
  return payload && payload.length <= 8192 ? payload : null;
}

/**
 * Takes the invite off the address once it has been read. It is single-use and personal: left in
 * place it would be bookmarked, synced into history, and offered again by a refresh.
 */
export function clearJoinFragment(): void {
  if (typeof window === 'undefined' || joinPayloadFromHash(window.location.hash) === null) return;
  const url = new URL(window.location.href);
  const params = new URLSearchParams(url.hash.replace(/^#/, ''));
  params.delete(JOIN_PARAM);
  const hash = params.toString();
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${hash ? `#${hash}` : ''}`);
}
