import { viewOf, ownerAt } from '../depth/tree';
import { flowIsPlayable } from '../document/flow';
import { cloneDocumentAsNew } from '../document/factory';
import { LIMITS } from '../document/limits';
import type { DraftDocument } from '../document/types';
import { parseDocument, type NormalizeResult } from '../document/validate';
import { serializeDocument } from '../export/project';
import { checkShareCancelled, compressShare, type ShareOptions } from './compress';
import { shareStream, transformShareBytes } from './streams';
import { decryptExportBytes, encryptExportBytes, PBKDF2_ITERATIONS, SECURE_EXPORT_FORMAT, SECURE_EXPORT_CRYPTO_VERSION, type SecureExportEnvelope } from '../crypto/passphraseExport';

/**
 * Read-only share links: the whole diagram, in the address itself.
 *
 * There is no server to hold a shared diagram, so the link *is* the diagram — `serializeDocument`'s
 * JSON, deflated and base64url-encoded into the fragment (`#d=1.<payload>`). Protected links use
 * `#d=2.<payload>`: the document and starting metadata are compressed together, then encrypted
 * with the same passphrase primitives as secure file exports. Only ciphertext goes in the URL.
 * A fragment never
 * reaches a server, the same reason `lib/documentUrl.ts` uses one, so even the host that serves the
 * app never sees what was shared. The flip side is spelled out in `docs/reference/privacy.md`:
 * an unprotected link is the diagram; a protected one additionally requires the separate
 * passphrase. Whatever keeps links (history, chat previews) keeps their payload too.
 *
 * `1.` is the format version. A later encoding changes the prefix, so a reader can tell the two
 * apart instead of failing on a payload it was never meant to understand.
 */

/** The fragment parameter the payload travels in. `lib/documentUrl.ts` owns `doc`; this owns `d`. */
export const SHARE_PARAM = 'd';
const FORMAT_VERSION = '1';
const PROTECTED_VERSION = '2';
export const SHARE_START_PARAM = 'start';
export interface ShareStart { path: string[]; flowId?: string }
export type SharedDocumentResult = (NormalizeResult | { ok: false; needsPassphrase: true; error: string })
  & { start?: ShareStart; startWarning?: string; protected?: boolean };

export function validatedShareStart(document: DraftDocument, value: unknown): ShareStart | null {
  if (!value || typeof value !== 'object') return null;
  const { path, flowId } = value as Partial<ShareStart>;
  if (!Array.isArray(path) || path.length > 32 || path.some((id) => typeof id !== 'string' || id.length > 200)) return null;
  if (path.length && !ownerAt(document, path)?.inside?.nodes.length) return null;
  const room = viewOf(document, path);
  if (!room) return null;
  if (flowId !== undefined && (typeof flowId !== 'string' || !room.flows.some((flow) => flow.id === flowId && flowIsPlayable(room, flow)))) return null;
  return { path, ...(flowId === undefined ? {} : { flowId }) };
}
/** The longest encoded payload a link may carry. Past this, chat apps truncate and browsers start
 *  refusing, so the honest answer is "export the file" rather than a link that only sometimes works. */
export const MAX_SHARE_PAYLOAD_BYTES = 32 * 1024;

export type EncodeShareLinkResult = { url: string } | { tooLarge: true; bytes: number };

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

export function shareLinkIsProtected(hash: string): boolean {
  return sharePayloadFromHash(hash)?.startsWith(`${PROTECTED_VERSION}.`) ?? false;
}

/** Fixed binary header: iteration count, 16-byte salt, 12-byte IV, then authenticated ciphertext.
 * Keeping the envelope binary avoids base64-encoding ciphertext twice in an already bounded URL. */
function packProtected(envelope: SecureExportEnvelope): Uint8Array<ArrayBuffer> {
  const decode = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  const ciphertext = decode(envelope.ciphertext);
  const packed = new Uint8Array(32 + ciphertext.length);
  new DataView(packed.buffer).setUint32(0, envelope.iterations);
  packed.set(decode(envelope.salt), 4);
  packed.set(decode(envelope.iv), 20);
  packed.set(ciphertext, 32);
  return packed;
}

function unpackProtected(bytes: Uint8Array): SecureExportEnvelope | null {
  if (bytes.length < 48) return null;
  const iterations = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  if (!iterations || iterations > PBKDF2_ITERATIONS * 10) return null;
  const base64 = (part: Uint8Array) => btoa(String.fromCharCode(...part));
  return {
    format: SECURE_EXPORT_FORMAT, cryptoVersion: SECURE_EXPORT_CRYPTO_VERSION, kdf: 'PBKDF2', iterations,
    salt: base64(bytes.subarray(4, 20)), iv: base64(bytes.subarray(20, 32)), ciphertext: base64(bytes.subarray(32)),
  };
}

/**
 * The link for `document` — the whole file, every room — or how far over the cap it landed.
 * `base` is the page the link should open (defaults to this one, without its fragment).
 */
export async function encodeShareLink(document: DraftDocument, base?: string, start?: ShareStart, passphrase?: string, options: ShareOptions = {}): Promise<EncodeShareLinkResult> {
  if (passphrase !== undefined && passphrase.length < 8) throw new Error('Use a passphrase of at least 8 characters.');
  checkShareCancelled(options.signal);
  options.onProgress?.('preparing');
  // Let the progress UI paint before serializing the snapshot or starting its worker.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  checkShareCancelled(options.signal);
  const serialized = serializeDocument(withoutBackgroundImage(document));
  const json = `{"document":${serialized},"start":${JSON.stringify(start ?? null)}}`;
  const compressed = await compressShare(json, passphrase !== undefined, options);
  checkShareCancelled(options.signal);
  if (passphrase !== undefined) options.onProgress?.('protecting');
  const encoded = passphrase === undefined ? compressed.bytes : packProtected(await encryptExportBytes(compressed.bytes, passphrase));
  checkShareCancelled(options.signal);
  const payload = `${passphrase === undefined ? FORMAT_VERSION : PROTECTED_VERSION}.${toBase64Url(encoded)}`;
  const params = new URLSearchParams({ [SHARE_PARAM]: payload });
  if (compressed.start && passphrase === undefined) params.set(SHARE_START_PARAM, JSON.stringify(compressed.start));
  const fragment = params.toString();
  if (fragment.length > MAX_SHARE_PAYLOAD_BYTES) return { tooLarge: true, bytes: fragment.length };
  const url = new URL(base ?? window.location.href);
  url.hash = fragment;
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
export async function decodeShareLink(hash: string, passphrase?: string): Promise<SharedDocumentResult | null> {
  const payload = sharePayloadFromHash(hash);
  if (payload === null) return null;
  const dot = payload.indexOf('.');
  const version = dot === -1 ? payload : payload.slice(0, dot);
  if (version !== FORMAT_VERSION && version !== PROTECTED_VERSION) {
    return { ok: false, error: 'This link was made with a newer version of Draft Canvas. Reload the page and try again.' };
  }
  if (hash.replace(/^#/, '').length > MAX_SHARE_PAYLOAD_BYTES) return { ok: false, error: 'This link is too long to be a Draft Canvas share link.' };
  let bytes = fromBase64Url(payload.slice(dot + 1));
  if (!bytes) return { ok: false, error: 'This share link is damaged — part of it may have been lost when it was copied.' };
  const protectedLink = version === PROTECTED_VERSION;
  if (protectedLink) {
    const envelope = unpackProtected(bytes);
    if (!envelope) return { ok: false, error: 'This protected share link is damaged.' };
    if (passphrase === undefined) return { ok: false, needsPassphrase: true, error: 'Enter the passphrase from the sender.' };
    const decrypted = await decryptExportBytes(envelope, passphrase);
    if (!decrypted.ok) return { ok: false, needsPassphrase: true, error: 'Incorrect passphrase, or this link is damaged.' };
    bytes = decrypted.bytes;
  }
  let json: string;
  let protectedStart: unknown;
  try {
    const inflated = await transformShareBytes(bytes, shareStream('DecompressionStream'), LIMITS.maxFileBytes);
    json = new TextDecoder('utf-8', { fatal: true }).decode(inflated);
    if (protectedLink) {
      const content: unknown = JSON.parse(json);
      if (!content || typeof content !== 'object' || !('document' in content)) throw new Error('Invalid share payload');
      json = JSON.stringify(content.document);
      protectedStart = 'start' in content ? content.start : undefined;
    }
  } catch {
    return { ok: false, error: 'This share link is damaged — part of it may have been lost when it was copied.' };
  }
  const result = parseDocument(json);
  if (!result.ok) return result;
  const rawStart = protectedLink ? undefined : new URLSearchParams(hash.replace(/^#/, '')).get(SHARE_START_PARAM);
  let start: ShareStart | null = null;
  if (protectedLink && protectedStart !== undefined) start = validatedShareStart(result.document, protectedStart);
  else if (rawStart != null) {
    try { start = validatedShareStart(result.document, JSON.parse(rawStart)); } catch { /* Invalid starting metadata never hides a valid diagram. */ }
  }
  return { ...result, document: cloneDocumentAsNew(result.document, result.document.metadata.title),
    protected: protectedLink,
    ...(start ? { start } : {}),
    ...((rawStart != null || protectedStart !== undefined) && !start ? { startWarning: 'That starting point is unavailable. Showing the diagram overview.' } : {}),
  };
}
