/**
 * The app's one outbound request that isn't collaboration: reading a file of the public starters
 * gallery, and only after the person chose to load it (`galleryStore.enable`). `tests/privacy.test.ts`
 * allows `fetch` in this file alone and checks it names no other origin.
 *
 * Nothing is sent but the file's path: no cookies or credentials, no referrer, and no request body.
 */

import { GALLERY_BASE, REQUEST_TIMEOUT_MS } from './source';

/** A path inside the gallery repository: lowercase segments, never `..`, never absolute. */
const SAFE_PATH = /^(?:[a-z0-9][a-z0-9._-]*\/)*[a-z0-9][a-z0-9._-]*\.(?:json|draftcanvas|draftstyle)$/;

export class GalleryRequestError extends Error {
  readonly reason: 'offline' | 'not-found' | 'too-large' | 'refused';

  constructor(reason: 'offline' | 'not-found' | 'too-large' | 'refused') {
    super(`Starters gallery request failed: ${reason}`);
    this.reason = reason;
    this.name = 'GalleryRequestError';
  }
}

/**
 * A response's body as text, decoded as `Response.text()` decodes it, read no further than
 * `maxBytes`. A missing or compressed Content-Length says nothing about what arrives, so the limit
 * holds while the bytes do, not after all of them are in memory.
 */
async function textWithin(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return response.text();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) {
      void reader.cancel().catch(() => undefined);
      throw new GalleryRequestError('too-large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** Reads one gallery file as text, refusing anything over `maxBytes`. */
export async function readGalleryFile(path: string, maxBytes: number, signal?: AbortSignal): Promise<string> {
  if (!SAFE_PATH.test(path) || path.includes('..')) throw new GalleryRequestError('refused');
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(GALLERY_BASE + path, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      // GitHub caches raw files for a few minutes; ask it to check rather than answer from the
      // browser's own cache, so Refresh means refresh.
      cache: 'no-cache',
      signal: controller.signal,
    });
    if (response.status === 404) throw new GalleryRequestError('not-found');
    if (!response.ok) throw new GalleryRequestError('offline');
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw new GalleryRequestError('too-large');
    const text = await textWithin(response, maxBytes);
    if (new TextEncoder().encode(text).length > maxBytes) throw new GalleryRequestError('too-large');
    return text;
  } catch (error) {
    if (error instanceof GalleryRequestError) throw error;
    throw new GalleryRequestError('offline');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}
