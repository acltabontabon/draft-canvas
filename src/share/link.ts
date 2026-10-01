import { cloneDocumentAsNew } from '../document/factory';
import { LIMITS } from '../document/limits';
import type { DraftDocument } from '../document/types';
import { parseDocument, type NormalizeResult } from '../document/validate';
import { serializeDocument } from '../export/project';

/**
 * Read-only share links: the whole diagram, in the address itself.
 *
 * There is no server to hold a shared diagram, so the link *is* the diagram — `serializeDocument`'s
 * JSON, deflated and base64url-encoded into the fragment (`#d=1.<payload>`). A fragment never
 * reaches a server, the same reason `lib/documentUrl.ts` uses one, so even the host that serves the
 * app never sees what was shared. The flip side is spelled out in `docs/reference/privacy.md`:
 * anyone who has the link has the diagram, and whatever keeps links (history, chat previews) keeps
 * it too.
 *
 * `1.` is the format version. A later encoding changes the prefix, so a reader can tell the two
 * apart instead of failing on a payload it was never meant to understand.
 */

/** The fragment parameter the payload travels in. `lib/documentUrl.ts` owns `doc`; this owns `d`. */
export const SHARE_PARAM = 'd';
const FORMAT_VERSION = '1';
/** The longest encoded payload a link may carry. Past this, chat apps truncate and browsers start
 *  refusing, so the honest answer is "export the file" rather than a link that only sometimes works. */
export const MAX_SHARE_PAYLOAD_BYTES = 32 * 1024;

export type EncodeShareLinkResult = { url: string } | { tooLarge: true; bytes: number };

/**
 * `CompressionStream`/`DecompressionStream` are read from `globalThis` rather than named directly:
 * under Vitest's jsdom environment the window's own globals shadow the page's, and jsdom has no
 * streams of its own — Node's are still there on `globalThis`, which is what the tests run against.
 */
type StreamPair = { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };
type StreamCtor = new (format: 'deflate-raw') => StreamPair;
function streamCtor(name: 'CompressionStream' | 'DecompressionStream'): StreamCtor {
  const ctor = (globalThis as unknown as Record<string, StreamCtor | undefined>)[name];
  if (!ctor) throw new Error(`${name} is not available in this browser.`);
  return ctor;
}

/**
 * Pushes `bytes` through a transform and collects what comes out, stopping at `limit` bytes of
 * output. The limit is what keeps a hostile payload — a few kilobytes that inflate to gigabytes —
 * from being read to the end before `parseDocument` ever gets to refuse it.
 */
async function transform(bytes: Uint8Array, stream: StreamPair, limit: number): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  let writeError: unknown;
  const written = (async () => {
    await writer.write(bytes);
    await writer.close();
  })().catch((error: unknown) => {
    writeError = error;
  });
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new Error('That link holds more than a diagram can.');
    }
    chunks.push(value);
  }
  await written;
  if (writeError) throw writeError;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

const CHUNK = 0x8000;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** The document as a link carries it: the background image stays behind — it alone would be most
 *  of the payload, and a link has no image store for it to land in. */
function withoutBackgroundImage(document: DraftDocument): DraftDocument {
  if (!document.settings.background.image) return document;
  const background = { ...document.settings.background };
  delete background.image;
  return { ...document, settings: { ...document.settings, background } };
}

/** The `d` value in a fragment, or null when the address carries none. */
export function sharePayloadFromHash(hash: string): string | null {
  return new URLSearchParams(hash.replace(/^#/, '')).get(SHARE_PARAM);
}

/**
 * The link for `document` — the whole file, every room — or how far over the cap it landed.
 * `base` is the page the link should open (defaults to this one, without its fragment).
 */
export async function encodeShareLink(document: DraftDocument, base?: string): Promise<EncodeShareLinkResult> {
  const json = serializeDocument(withoutBackgroundImage(document));
  const bytes = new TextEncoder().encode(json);
  const Compression = streamCtor('CompressionStream');
  const deflated = await transform(bytes, new Compression('deflate-raw'), Number.MAX_SAFE_INTEGER);
  const payload = `${FORMAT_VERSION}.${toBase64Url(deflated)}`;
  if (payload.length > MAX_SHARE_PAYLOAD_BYTES) return { tooLarge: true, bytes: payload.length };
  const url = new URL(base ?? window.location.href);
  url.hash = `${SHARE_PARAM}=${payload}`;
  return { url: url.toString() };
}

/**
 * The document a `#d=` fragment carries, validated as any import is — this is the only door a
 * shared diagram comes in by, and the link is untrusted input from end to end. `null` when the
 * fragment carries no share payload at all.
 *
 * The result's document always has a fresh id: the sender's id means nothing here, and keeping it
 * could collide with a diagram already in the reader's own library when they make a copy.
 */
export async function decodeShareLink(hash: string): Promise<NormalizeResult | null> {
  const payload = sharePayloadFromHash(hash);
  if (payload === null) return null;
  const dot = payload.indexOf('.');
  const version = dot === -1 ? payload : payload.slice(0, dot);
  if (version !== FORMAT_VERSION) {
    return { ok: false, error: 'This link was made with a newer version of Draft Canvas. Reload the page and try again.' };
  }
  if (payload.length > MAX_SHARE_PAYLOAD_BYTES) return { ok: false, error: 'This link is too long to be a Draft Canvas share link.' };
  const bytes = fromBase64Url(payload.slice(dot + 1));
  if (!bytes) return { ok: false, error: 'This share link is damaged — part of it may have been lost when it was copied.' };
  let json: string;
  try {
    const Decompression = streamCtor('DecompressionStream');
    const inflated = await transform(bytes, new Decompression('deflate-raw'), LIMITS.maxFileBytes);
    json = new TextDecoder('utf-8', { fatal: true }).decode(inflated);
  } catch {
    return { ok: false, error: 'This share link is damaged — part of it may have been lost when it was copied.' };
  }
  const result = parseDocument(json);
  if (!result.ok) return result;
  return { ...result, document: cloneDocumentAsNew(result.document, result.document.metadata.title) };
}
