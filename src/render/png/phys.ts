/**
 * The browser's PNG encoder writes no physical size, so a 2× export lands in a document at twice
 * the size it was drawn at. A `pHYs` chunk — pixels per metre at 96 dpi × the export scale — tells
 * the document the pixels are dense, not big. Pure bytes in, pure bytes out: the encoder's output
 * is never re-encoded, and nothing here depends on the clock, so an export stays reproducible.
 */

const PNG_SIGNATURE_LENGTH = 8;
/** Length (4) + type (4) + IHDR data (13) + CRC (4): the first chunk is always this long. */
const IHDR_CHUNK_LENGTH = 4 + 4 + 13 + 4;
const CHUNK_TYPE_PHYS = [0x70, 0x48, 0x59, 0x73]; // "pHYs"
const CSS_DPI = 96;
const METRES_PER_INCH = 0.0254;

/** Pixels per metre a PNG needs to paste at its drawn size when exported at `scale`. */
export function pixelsPerMetre(scale: number): number {
  return Math.round((CSS_DPI * scale) / METRES_PER_INCH);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** The PNG spec's CRC-32 (ISO 3309), over the chunk's type and data bytes together. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = (CRC_TABLE[(crc ^ (bytes[i] ?? 0)) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) |
      ((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) |
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

/** The complete `pHYs` chunk (length, type, data, CRC) for `scale`. */
export function physChunk(scale: number): Uint8Array {
  const ppm = pixelsPerMetre(scale);
  // Type + data, hashed together; the length is not part of the CRC.
  const body = new Uint8Array(4 + 9);
  body.set(CHUNK_TYPE_PHYS, 0);
  writeUint32(body, 4, ppm);
  writeUint32(body, 8, ppm);
  body[12] = 1; // unit specifier: metres

  const chunk = new Uint8Array(4 + body.length + 4);
  writeUint32(chunk, 0, 9);
  chunk.set(body, 4);
  writeUint32(chunk, 4 + body.length, crc32(body));
  return chunk;
}

/**
 * `png` with a `pHYs` chunk inserted right after IHDR. Anything that is not a PNG (or that already
 * carries a physical size) is handed back untouched: this only ever adds what the encoder left out.
 */
export function withPhysChunk(png: Uint8Array<ArrayBuffer>, scale: number): Uint8Array<ArrayBuffer> {
  if (!isPng(png) || hasPhys(png)) return png;
  const splitAt = PNG_SIGNATURE_LENGTH + IHDR_CHUNK_LENGTH;
  const chunk = physChunk(scale);
  const out = new Uint8Array(png.length + chunk.length);
  out.set(png.subarray(0, splitAt), 0);
  out.set(chunk, splitAt);
  out.set(png.subarray(splitAt), splitAt + chunk.length);
  return out;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE_LENGTH + IHDR_CHUNK_LENGTH) return false;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  // The first chunk must be IHDR — anything else is not a PNG worth touching.
  return (
    bytes[PNG_SIGNATURE_LENGTH + 4] === 0x49 &&
    bytes[PNG_SIGNATURE_LENGTH + 5] === 0x48 &&
    bytes[PNG_SIGNATURE_LENGTH + 6] === 0x44 &&
    bytes[PNG_SIGNATURE_LENGTH + 7] === 0x52
  );
}

/** Walks the chunk list; a `pHYs` chunk must precede IDAT, so the walk stops there. */
function hasPhys(bytes: Uint8Array): boolean {
  let offset = PNG_SIGNATURE_LENGTH;
  while (offset + 8 <= bytes.length) {
    const length = readUint32(bytes, offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (type === 'pHYs') return true;
    if (type === 'IDAT' || type === 'IEND') return false;
    offset += 4 + 4 + length + 4;
  }
  return false;
}
