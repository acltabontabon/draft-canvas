/**
 * Whether this page can use the Web Crypto API that every stored diagram is
 * encrypted with (see `documentCipher.ts` and `keyStore.ts`).
 *
 * Browsers only expose `crypto.subtle` in a secure context: HTTPS, or
 * `localhost`. A self-hosted copy opened over plain `http://` from another
 * address gets no `crypto.subtle`, so nothing can be saved there. Checked up
 * front so the home screen can say so, rather than "New canvas" failing
 * without a word.
 *
 * `isSecureContext` is compared to `false` explicitly: real browsers always
 * define it, but test environments may not.
 */
export function canEncryptLocally(): boolean {
  if (typeof window !== 'undefined' && window.isSecureContext === false) return false;
  return Boolean(globalThis.crypto?.subtle);
}
