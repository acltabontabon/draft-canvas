/**
 * A dependency-free ZIP writer and reader, store-only (no compression).
 *
 * Everything Draft Canvas puts in an archive is either already compressed (PNG) or small enough
 * not to matter (SVG, text), so Deflate would buy nothing and cost a dependency or a
 * `CompressionStream` that is not on every platform the editor ships to. Stored entries are the one
 * part of the format every tool reads.
 *
 * The output is reproducible: timestamps are pinned to the ZIP epoch (1980-01-01 00:00), names are
 * written as UTF-8 with the language-encoding flag set, and nothing else in the headers depends on
 * the machine that wrote them — the same entries always give the same bytes, which is what lets a
 * test compare an archive byte for byte.
 *
 * Free of React and of the DOM, like the rest of `export/`'s model-side helpers.
 */

import { LIMITS } from '../document/limits';

export interface ZipEntry {
  /** The path inside the archive, forward slashes, no leading slash. */
  name: string;
  data: Uint8Array | string;
}

export interface UnzippedEntry {
  name: string;
  data: Uint8Array;
}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const END_RECORD_SIZE = 22;
/** ZIP 2.0 — the version every reader understands stored entries at. */
const VERSION = 20;
/** Bit 11: the name is UTF-8. Nothing else (no data descriptor, no encryption). */
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
/** DOS date for 1980-01-01, the earliest the format can express; time 00:00 is zero. */
const EPOCH_DATE = (0 << 9) | (1 << 5) | 1;
const EPOCH_TIME = 0;
/** ZIP32 field width; this writer has no reason to grow past it. */
const MAX_32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** The standard CRC-32 (IEEE 802.3, as ZIP, PNG and gzip use it), as an unsigned 32-bit value. */
export function crc32(bytes: Uint8Array, seed = 0): number {
  let crc = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

function bytesOf(data: Uint8Array | string): Uint8Array {
  return typeof data === 'string' ? encoder.encode(data) : data;
}

/** Writes an archive holding `entries`, in order, each stored uncompressed. */
export function zipFiles(entries: readonly ZipEntry[]): Uint8Array<ArrayBuffer> {
  if (entries.length > MAX_ENTRIES) throw new Error(`A ZIP archive holds at most ${MAX_ENTRIES} files.`);

  const prepared = entries.map((entry) => {
    const name = encoder.encode(entry.name);
    const data = bytesOf(entry.data);
    if (name.length > MAX_ENTRIES) throw new Error(`"${entry.name.slice(0, 40)}…" is too long a name for a ZIP entry.`);
    if (data.length > MAX_32) throw new Error(`"${entry.name}" is too large for a ZIP archive.`);
    return { name, data, crc: crc32(data) };
  });

  let localSize = 0;
  let centralSize = 0;
  for (const { name, data } of prepared) {
    localSize += LOCAL_HEADER_SIZE + name.length + data.length;
    centralSize += CENTRAL_HEADER_SIZE + name.length;
  }
  const total = localSize + centralSize + END_RECORD_SIZE;
  if (localSize > MAX_32 || total > MAX_32) throw new Error('The archive would be too large for the ZIP format.');

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let cursor = 0;
  const offsets: number[] = [];

  for (const { name, data, crc } of prepared) {
    offsets.push(cursor);
    view.setUint32(cursor, LOCAL_HEADER, true);
    view.setUint16(cursor + 4, VERSION, true);
    view.setUint16(cursor + 6, FLAG_UTF8, true);
    view.setUint16(cursor + 8, METHOD_STORE, true);
    view.setUint16(cursor + 10, EPOCH_TIME, true);
    view.setUint16(cursor + 12, EPOCH_DATE, true);
    view.setUint32(cursor + 14, crc, true);
    view.setUint32(cursor + 18, data.length, true);
    view.setUint32(cursor + 22, data.length, true);
    view.setUint16(cursor + 26, name.length, true);
    view.setUint16(cursor + 28, 0, true);
    cursor += LOCAL_HEADER_SIZE;
    out.set(name, cursor);
    cursor += name.length;
    out.set(data, cursor);
    cursor += data.length;
  }

  const centralStart = cursor;
  prepared.forEach(({ name, data, crc }, index) => {
    view.setUint32(cursor, CENTRAL_HEADER, true);
    view.setUint16(cursor + 4, VERSION, true);
    view.setUint16(cursor + 6, VERSION, true);
    view.setUint16(cursor + 8, FLAG_UTF8, true);
    view.setUint16(cursor + 10, METHOD_STORE, true);
    view.setUint16(cursor + 12, EPOCH_TIME, true);
    view.setUint16(cursor + 14, EPOCH_DATE, true);
    view.setUint32(cursor + 16, crc, true);
    view.setUint32(cursor + 20, data.length, true);
    view.setUint32(cursor + 24, data.length, true);
    view.setUint16(cursor + 28, name.length, true);
    view.setUint16(cursor + 30, 0, true); // extra field
    view.setUint16(cursor + 32, 0, true); // comment
    view.setUint16(cursor + 34, 0, true); // disk number start
    view.setUint16(cursor + 36, 0, true); // internal attributes
    view.setUint32(cursor + 38, 0, true); // external attributes
    view.setUint32(cursor + 42, offsets[index]!, true);
    cursor += CENTRAL_HEADER_SIZE;
    out.set(name, cursor);
    cursor += name.length;
  });

  view.setUint32(cursor, END_OF_CENTRAL_DIRECTORY, true);
  view.setUint16(cursor + 4, 0, true);
  view.setUint16(cursor + 6, 0, true);
  view.setUint16(cursor + 8, prepared.length, true);
  view.setUint16(cursor + 10, prepared.length, true);
  view.setUint32(cursor + 12, centralSize, true);
  view.setUint32(cursor + 16, centralStart, true);
  view.setUint16(cursor + 20, 0, true);

  return out;
}

/**
 * Reads a store-only archive back. A compressed entry is refused rather than skipped: a caller
 * asking for the archive's files would otherwise get some of them and no sign of the rest. The
 * uncompressed total is capped at the document size limit, since sizes come from the file and an
 * absurd one must fail before anything is allocated on its say-so.
 */
export function unzipFiles(bytes: Uint8Array): UnzippedEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = findEndRecord(bytes, view);
  if (end === -1) throw new Error('Not a ZIP archive: the end-of-central-directory record is missing.');

  const disk = view.getUint16(end + 4, true);
  const centralDisk = view.getUint16(end + 6, true);
  const count = view.getUint16(end + 10, true);
  const centralSize = view.getUint32(end + 12, true);
  const centralStart = view.getUint32(end + 16, true);
  if (disk !== 0 || centralDisk !== 0) throw new Error('Multi-disk ZIP archives are not supported.');
  if (centralStart + centralSize > end) throw new Error('Not a ZIP archive: the central directory lies outside the file.');

  const entries: UnzippedEntry[] = [];
  let cursor = centralStart;
  let budget = LIMITS.maxFileBytes;
  for (let index = 0; index < count; index += 1) {
    if (cursor + CENTRAL_HEADER_SIZE > end || view.getUint32(cursor, true) !== CENTRAL_HEADER) {
      throw new Error('Not a ZIP archive: a central directory entry is malformed.');
    }
    const method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(bytes.subarray(cursor + CENTRAL_HEADER_SIZE, cursor + CENTRAL_HEADER_SIZE + nameLength));
    cursor += CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength;

    if (method !== METHOD_STORE) {
      throw new Error(`"${name}" is compressed (method ${method}); Draft Canvas reads only stored ZIP entries.`);
    }
    if (compressedSize !== size) throw new Error(`"${name}" declares two different sizes for a stored entry.`);
    budget -= size;
    if (budget < 0) {
      throw new Error(`The archive unpacks to more than ${LIMITS.maxFileBytes / 1024 / 1024} MB.`);
    }

    if (localOffset + LOCAL_HEADER_SIZE > centralStart || view.getUint32(localOffset, true) !== LOCAL_HEADER) {
      throw new Error(`"${name}" points at a missing local header.`);
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + LOCAL_HEADER_SIZE + localNameLength + localExtraLength;
    if (dataStart + size > centralStart) throw new Error(`"${name}" runs past the end of the archive.`);

    const data = bytes.slice(dataStart, dataStart + size);
    if (crc32(data) !== crc) throw new Error(`"${name}" is corrupt: its checksum does not match.`);
    entries.push({ name, data });
  }
  return entries;
}

/**
 * The end record sits at the very end, but may be followed by a comment of up to 65535 bytes, so
 * it is found by scanning back for its signature from the last place it could start.
 */
function findEndRecord(bytes: Uint8Array, view: DataView): number {
  const last = bytes.length - END_RECORD_SIZE;
  const first = Math.max(0, last - 0xffff);
  for (let at = last; at >= first; at -= 1) {
    if (view.getUint32(at, true) !== END_OF_CENTRAL_DIRECTORY) continue;
    const commentLength = view.getUint16(at + 20, true);
    if (at + END_RECORD_SIZE + commentLength === bytes.length) return at;
  }
  return -1;
}
