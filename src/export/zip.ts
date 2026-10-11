/**
 * ZIP export through fflate and a bounded, checksum-verifying store-only reader.
 *
 * Exports remain store-only so older Draft Canvas versions can restore them. The bounded reader
 * retains checksum verification and rejects compression before allocating any expanded data.
 *
 * The output is reproducible: timestamps are pinned to the ZIP epoch (1980-01-01 00:00), non-ASCII names are
 * written as UTF-8 with the language-encoding flag set, and nothing else in the headers depends on
 * the machine that wrote them — the same entries always give the same bytes, which is what lets a
 * test compare an archive byte for byte.
 *
 * Free of React and of the DOM, like the rest of `export/`'s model-side helpers.
 */

import { Zip, ZipPassThrough } from 'fflate';
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

const METHOD_STORE = 0;
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

  const files = entries.map((entry) => ({ name: entry.name, data: bytesOf(entry.data) }));
  let total = END_RECORD_SIZE;
  for (const entry of files) {
    const nameLength = encoder.encode(entry.name).length;
    if (nameLength > MAX_ENTRIES) throw new Error('ZIP entry name is too long.');
    if (entry.data.length > MAX_32) throw new Error('ZIP entry is too large.');
    // The streaming writer appends a 16-byte data descriptor after each stored entry.
    total += entry.data.length + nameLength * 2 + LOCAL_HEADER_SIZE + CENTRAL_HEADER_SIZE + 16;
    if (total > MAX_32) throw new Error('The archive would be too large for the ZIP format.');
  }

  const output = new Uint8Array(total);
  let offset = 0;
  const zip = new Zip((error, chunk) => {
    if (error) throw error;
    output.set(chunk, offset);
    offset += chunk.length;
  });
  // Entries, rather than zipSync's object keys, preserve numeric names, duplicates and __proto__.
  for (const entry of files) {
    const file = new ZipPassThrough(entry.name);
    file.mtime = new Date(1980, 0, 1);
    zip.add(file);
    file.push(entry.data, true);
  }
  zip.end();
  return output;
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
