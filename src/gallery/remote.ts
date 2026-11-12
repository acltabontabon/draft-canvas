/**
 * The app's one outbound request that isn't collaboration: reading a file of the public starters
 * gallery, and only after the person chose to load it (`galleryStore.enable`). `tests/privacy.test.ts`
 * allows `fetch` in this file alone and checks it names no other origin.
 *
 * Nothing is sent but the file's path: no cookies or credentials, no referrer, and no request body.
 */

import { GALLERY_BASE, REQUEST_TIMEOUT_MS } from './source';

/** A path inside the gallery repository: lowercase segments, never `..`, never absolute. */
const SAFE_PATH = /^(?:[a-z0-9][a-z0-9._-]*\/)*[a-z0-9][a-z0-9._-]*\.(?:json|draftcanvas)$/;

export class GalleryRequestError extends Error {
  readonly reason: 'offline' | 'not-found' | 'too-large' | 'refused';

  constructor(reason: 'offline' | 'not-found' | 'too-large' | 'refused') {
    super(`Starters gallery request failed: ${reason}`);
    this.reason = reason;
    this.name = 'GalleryRequestError';
  }
}

/** Reads one gallery file as text, refusing anything over `maxBytes`. */
export async function readGalleryFile(path: string, maxBytes: number): Promise<string> {
  if (!SAFE_PATH.test(path) || path.includes('..')) throw new GalleryRequestError('refused');
  let response: Response;
  try {
    response = await fetch(GALLERY_BASE + path, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      // GitHub caches raw files for a few minutes; ask it to check rather than answer from the
      // browser's own cache, so Refresh means refresh.
      cache: 'no-cache',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new GalleryRequestError('offline');
  }
  if (response.status === 404) throw new GalleryRequestError('not-found');
  if (!response.ok) throw new GalleryRequestError('offline');
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new GalleryRequestError('too-large');
  const text = await response.text();
  if (new TextEncoder().encode(text).length > maxBytes) throw new GalleryRequestError('too-large');
  return text;
}
