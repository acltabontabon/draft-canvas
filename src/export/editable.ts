/**
 * An image that is still a diagram. The `.draftcanvas` text goes inside the picture — an SVG
 * `<metadata>` element, a PNG `iTXt` chunk — where every viewer ignores it and Draft Canvas can read
 * it back (`import/editableImage.ts`). The picture itself is untouched: the SVG draws the same, the
 * PNG's pixels are the encoder's own bytes with one ancillary chunk added, so a reader that does not
 * know the keyword sees an ordinary image.
 *
 * Pure bytes and strings in and out, like `render/png/phys.ts`, and nothing here depends on the
 * clock: the same document in the same picture is the same file twice.
 */

import type { DraftDocument } from '../document/types';
import { parseDocument, type NormalizeResult } from '../document/validate';
import { crc32 } from '../render/png/phys';
import { escapeXmlText } from '../render/svg/element';
import { serializeDocument } from './project';

/** The `id` of the SVG element and the keyword of the PNG chunk — what a reader looks for. */
export const EDITABLE_KEY = 'draftcanvas';

// ---- SVG ------------------------------------------------------------------------------------

/**
 * `svg` with the document inside a `<metadata id="draftcanvas">` right after the root's start tag.
 * The JSON is XML-escaped text rather than a CDATA section: a title containing `]]>` would end a
 * CDATA section early, and escaping has no such sequence. Any earlier copy is replaced, so
 * embedding twice never doubles the file.
 */
export function withDocumentMetadata(svg: string, document: DraftDocument): string {
  const stripped = svg.replace(metadataPattern(), '');
  const open = stripped.match(/<svg\b[^>]*>/);
  if (!open || open.index === undefined) return stripped;
  const at = open.index + open[0].length;
  const element = `<metadata id="${EDITABLE_KEY}">${escapeXmlText(serializeDocument(document))}</metadata>`;
  return `${stripped.slice(0, at)}${element}${stripped.slice(at)}`;
}

function metadataPattern(): RegExp {
  return new RegExp(`<metadata\\s+id="${EDITABLE_KEY}"\\s*>([\\s\\S]*?)</metadata>`);
}

/** The document an SVG carries, or `null` when it carries none — a plain picture is not an error. */
export function readDocumentFromSvg(text: string): NormalizeResult | null {
  const match = text.match(metadataPattern());
  if (!match) return null;
  return parseDocument(unescapeXml(match[1]!));
}

/** The inverse of `escapeXmlText`/`escapeXmlAttr`, for text this module wrote itself. */
function unescapeXml(text: string): string {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

// ---- PNG ------------------------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const SIGNATURE_LENGTH = 8;
/** Length (4) + type (4) + IHDR data (13) + CRC (4): the first chunk is always this long. */
const IHDR_CHUNK_LENGTH = 4 + 4 + 13 + 4;
const CHUNK_TYPE_ITXT = 'iTXt';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function readUint32(bytes: Uint8Array, offset: number): number {
  return (((bytes[offset] ?? 0) << 24) | ((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0)) >>> 0;
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < SIGNATURE_LENGTH + IHDR_CHUNK_LENGTH) return false;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  return typeOf(bytes, SIGNATURE_LENGTH) === 'IHDR';
}

function typeOf(bytes: Uint8Array, chunkOffset: number): string {
  return String.fromCharCode(...bytes.subarray(chunkOffset + 4, chunkOffset + 8));
}

/**
 * The complete `iTXt` chunk carrying the document: keyword, a null, compression flag and method
 * (both 0: uncompressed — the document is small beside the pixels, and a reader then needs no
 * inflater), an empty language tag and translated keyword, then the text as UTF-8.
 */
export function documentChunk(document: DraftDocument): Uint8Array<ArrayBuffer> {
  const text = encoder.encode(serializeDocument(document));
  const keyword = encoder.encode(EDITABLE_KEY);
  const data = new Uint8Array(keyword.length + 1 + 1 + 1 + 1 + 1 + text.length);
  let at = 0;
  data.set(keyword, at);
  at += keyword.length;
  data[at++] = 0; // keyword terminator
  data[at++] = 0; // compression flag: uncompressed
  data[at++] = 0; // compression method
  data[at++] = 0; // language tag: empty
  data[at++] = 0; // translated keyword: empty
  data.set(text, at);

  const body = new Uint8Array(4 + data.length);
  body.set(encoder.encode(CHUNK_TYPE_ITXT), 0);
  body.set(data, 4);
  const chunk = new Uint8Array(4 + body.length + 4);
  writeUint32(chunk, 0, data.length);
  chunk.set(body, 4);
  writeUint32(chunk, 4 + body.length, crc32(body));
  return chunk;
}

/**
 * `png` with the document chunk inserted right after IHDR, any earlier `draftcanvas` chunk dropped.
 * Anything that is not a PNG is handed back untouched.
 */
export function withDocumentChunk(png: Uint8Array<ArrayBuffer>, document: DraftDocument): Uint8Array<ArrayBuffer> {
  if (!isPng(png)) return png;
  const stripped = withoutDocumentChunks(png);
  const splitAt = SIGNATURE_LENGTH + IHDR_CHUNK_LENGTH;
  const chunk = documentChunk(document);
  const out = new Uint8Array(stripped.length + chunk.length);
  out.set(stripped.subarray(0, splitAt), 0);
  out.set(chunk, splitAt);
  out.set(stripped.subarray(splitAt), splitAt + chunk.length);
  return out;
}

interface Chunk {
  offset: number;
  length: number;
  type: string;
}

/** Every chunk in order; stops at the first one that runs past the end, so a truncated file is safe. */
function chunksOf(bytes: Uint8Array): Chunk[] {
  const chunks: Chunk[] = [];
  let offset = SIGNATURE_LENGTH;
  while (offset + 12 <= bytes.length) {
    const length = readUint32(bytes, offset);
    if (offset + 12 + length > bytes.length) break;
    chunks.push({ offset, length, type: typeOf(bytes, offset) });
    offset += 12 + length;
  }
  return chunks;
}

function keywordOf(bytes: Uint8Array, chunk: Chunk): string {
  const start = chunk.offset + 8;
  const end = Math.min(start + 80, start + chunk.length);
  let at = start;
  while (at < end && bytes[at] !== 0) at += 1;
  return String.fromCharCode(...bytes.subarray(start, at));
}

function isDocumentChunk(bytes: Uint8Array, chunk: Chunk): boolean {
  return chunk.type === CHUNK_TYPE_ITXT && keywordOf(bytes, chunk) === EDITABLE_KEY;
}

function withoutDocumentChunks(png: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const chunks = chunksOf(png);
  if (!chunks.some((chunk) => isDocumentChunk(png, chunk))) return png;
  const parts: Uint8Array[] = [png.subarray(0, SIGNATURE_LENGTH)];
  for (const chunk of chunks) if (!isDocumentChunk(png, chunk)) parts.push(png.subarray(chunk.offset, chunk.offset + 12 + chunk.length));
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * The document a PNG carries, or `null` when it carries none. A chunk whose checksum does not
 * match, or whose text is not UTF-8, is ignored the same way: a damaged file is a plain picture,
 * never a broken import.
 */
export function readDocumentFromPng(bytes: Uint8Array): NormalizeResult | null {
  if (!isPng(bytes)) return null;
  for (const chunk of chunksOf(bytes)) {
    if (!isDocumentChunk(bytes, chunk)) continue;
    const body = bytes.subarray(chunk.offset + 4, chunk.offset + 8 + chunk.length);
    const stored = readUint32(bytes, chunk.offset + 8 + chunk.length);
    if (crc32(body) !== stored) continue;
    const data = bytes.subarray(chunk.offset + 8, chunk.offset + 8 + chunk.length);
    const text = itxtText(data);
    if (text === null) continue;
    return parseDocument(text);
  }
  return null;
}

/** The text field of an uncompressed `iTXt` payload, past its keyword, flags, language and translation. */
function itxtText(data: Uint8Array): string | null {
  let at = 0;
  while (at < data.length && data[at] !== 0) at += 1; // keyword
  at += 1;
  const compressed = data[at] === 1;
  at += 2; // compression flag + method
  while (at < data.length && data[at] !== 0) at += 1; // language tag
  at += 1;
  while (at < data.length && data[at] !== 0) at += 1; // translated keyword
  at += 1;
  if (compressed || at > data.length) return null;
  try {
    return decoder.decode(data.subarray(at));
  } catch {
    return null;
  }
}
