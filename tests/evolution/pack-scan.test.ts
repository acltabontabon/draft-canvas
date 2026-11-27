import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { PackRejected, scanPack, type PackLimits, type ScanWork } from '../../src/evolution/packScan';
import { HAS_GIT, gitOk, scratch } from './realGit';

const LIMITS: PackLimits = { maxObjects: 1000, maxObjectBytes: 1024 * 1024, maxTotalInflated: 8 * 1024 * 1024, maxDeltaDepth: 50 };

/** A pack of whole objects: `[type, declared size, inflated content]`. The trailer is not checked by the scan. */
function pack(objects: [number, number, Uint8Array][], extra = new Uint8Array()): Uint8Array {
  const parts: number[] = [0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, objects.length];
  for (const [type, size, content] of objects) {
    let rest = size >>> 4;
    parts.push(((rest > 0 ? 0x80 : 0) | (type << 4) | (size & 0x0f)) & 0xff);
    while (rest > 0) {
      const byte = rest & 0x7f;
      rest >>>= 7;
      parts.push(rest > 0 ? byte | 0x80 : byte);
    }
    parts.push(...zlibSync(content));
  }
  parts.push(...extra, ...new Array(20).fill(0));
  return Uint8Array.from(parts);
}

const text = (s: string) => new TextEncoder().encode(s);

/** Bits as deflate reads them: least significant first; Huffman codes most significant first. */
class BitWriter {
  readonly bytes: number[] = [];
  private current = 0;
  private filled = 0;
  put(value: number, count: number) {
    for (let i = 0; i < count; i += 1) {
      this.current |= ((value >>> i) & 1) << this.filled;
      this.filled += 1;
      if (this.filled === 8) this.align();
    }
  }
  code(code: number, length: number) {
    for (let i = length - 1; i >= 0; i -= 1) this.put((code >>> i) & 1, 1);
  }
  align() {
    if (this.filled === 0) return;
    this.bytes.push(this.current);
    this.current = 0;
    this.filled = 0;
  }
  raw(data: ArrayLike<number>) {
    for (let i = 0; i < data.length; i += 1) this.bytes.push(data[i]!);
  }
}

function adler32(data: ArrayLike<number>): number[] {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i += 1) {
    a = (a + data[i]!) % 65521;
    b = (b + a) % 65521;
  }
  return [(b >>> 8) & 0xff, b & 0xff, (a >>> 8) & 0xff, a & 0xff];
}

/** A stored block's header as read at a byte boundary: BFINAL and BTYPE, LEN, NLEN. */
function stored(final: boolean, length: number): number[] {
  return [final ? 1 : 0, length & 0xff, length >>> 8, ~length & 0xff, (~length >>> 8) & 0xff];
}

/** A pack entry's type and size header. */
function objectHeader(type: number, size: number): number[] {
  const out = [(type << 4) | (size & 0x0f)];
  for (let rest = Math.floor(size / 16); rest > 0; rest = Math.floor(rest / 128)) {
    out[out.length - 1]! |= 0x80;
    out.push(rest & 0x7f);
  }
  return out;
}

/** Canonical codes for `lengths` (RFC 1951, 3.2.2); 0 where a symbol has none. */
function canonical(lengths: number[]): number[] {
  const count = new Array<number>(16).fill(0);
  for (const length of lengths) if (length > 0) count[length] = count[length]! + 1;
  const next = new Array<number>(16).fill(0);
  for (let bits = 1, code = 0; bits < 16; bits += 1) next[bits] = code = (code + count[bits - 1]!) << 1;
  return lengths.map((length) => (length > 0 ? next[length]!++ : 0));
}

const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/**
 * A dynamic block with these literal/length and distance code lengths, then `symbols` in stream
 * order, each `[which code, symbol, extra bits' value, how many extra bits]`. Code lengths go out one
 * by one, zeros in runs, under a complete code-length code: symbols 0 to 12 at four bits, 13 to 18 at five.
 */
function dynamicBlock(w: BitWriter, final: boolean, literals: number[], distances: number[], symbols: ['literal' | 'distance', number, number, number][]) {
  const all = [...literals, ...distances];
  const sent: [number, number, number][] = [];
  for (let i = 0; i < all.length; ) {
    let zeros = 0;
    while (i + zeros < all.length && all[i + zeros] === 0 && zeros < 138) zeros += 1;
    if (zeros >= 11) sent.push([18, zeros - 11, 7]);
    else if (zeros >= 3) sent.push([17, zeros - 3, 3]);
    else zeros = 0;
    if (zeros === 0) sent.push([all[i]!, 0, 0]);
    i += Math.max(zeros, 1);
  }
  const lengthLengths = Array.from({ length: 19 }, (_, symbol) => (symbol < 13 ? 4 : 5));
  const lengthCodes = canonical(lengthLengths);
  w.put(final ? 1 : 0, 1);
  w.put(2, 2);
  w.put(literals.length - 257, 5);
  w.put(distances.length - 1, 5);
  w.put(19 - 4, 4);
  for (const symbol of CODE_LENGTH_ORDER) w.put(lengthLengths[symbol]!, 3);
  for (const [symbol, extra, bits] of sent) {
    w.code(lengthCodes[symbol]!, lengthLengths[symbol]!);
    if (bits) w.put(extra, bits);
  }
  const literalCodes = canonical(literals);
  const distanceCodes = canonical(distances);
  for (const [kind, symbol, extra, bits] of symbols) {
    if (kind === 'literal') w.code(literalCodes[symbol]!, literals[symbol]!);
    else w.code(distanceCodes[symbol]!, distances[symbol]!);
    if (bits) w.put(extra, bits);
  }
}

/** An offset delta's distance back to its base, as Git encodes it. */
function baseDistance(distance: number): number[] {
  let rest = distance;
  const out = [rest & 0x7f];
  while ((rest = Math.floor(rest / 128)) > 0) {
    rest -= 1;
    out.unshift(0x80 | (rest & 0x7f));
  }
  return out;
}

/**
 * A five-byte blob, then `deltas` in order: `ref` names its base by id (each the entry before it, as a
 * chain of them would), `ofs` builds on the entry before it by offset. Each turns five bytes into five.
 */
function deltaChain(deltas: ('ref' | 'ofs')[]): Uint8Array {
  const count = deltas.length + 1;
  const out: number[] = [0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, count >>> 24, (count >>> 16) & 0xff, (count >>> 8) & 0xff, count & 0xff];
  let previous = out.length;
  out.push(...objectHeader(3, 5), ...zlibSync(text('hello')));
  const delta = Uint8Array.from([5, 5, 5, ...text('hallo')]);
  deltas.forEach((kind, i) => {
    const start = out.length;
    out.push(...objectHeader(kind === 'ref' ? 7 : 6, delta.length));
    if (kind === 'ref') out.push(...new Array<number>(20).fill(i + 1));
    else out.push(...baseDistance(start - previous));
    out.push(...zlibSync(delta));
    previous = start;
  });
  out.push(...new Array<number>(20).fill(0));
  return Uint8Array.from(out);
}

/**
 * A pack built to read as two harmless objects to a scan that finds where a stream ends by looking
 * for its checksum, while the inflater indexing it reads one object whose stream goes on: object 1
 * declares 9 bytes, its checksum is planted where the scan's first chunk ends, and what the scan
 * takes for object 2 is, to the inflater, more of object 1: a stored block, then `runs` matches of
 * 258 bytes each.
 */
function desynchronised(runs: number): Uint8Array {
  const shown = [...text('innocent!')];
  const out: number[] = [0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 2, ...objectHeader(3, shown.length)];
  const first = new BitWriter();
  first.raw([0x78, 0x01, ...stored(false, shown.length), ...shown]);
  // Empty stored blocks up to five bytes short of the scan's first 4 KiB chunk, so the stored block
  // that hides the rest starts exactly where that chunk ends.
  while (first.bytes.length < 4091) first.raw(stored(false, 0));
  // What follows, as the inflater reads it: a fixed-Huffman block of long matches, then a stored
  // block whose five bytes are, to the scan, the final stored block header of object 2.
  const body = new BitWriter();
  body.put(0, 1);
  body.put(1, 2);
  for (let i = 0; i < runs; i += 1) {
    body.code(0xc5, 8); // length 258
    body.code(0, 5); // distance 1
  }
  body.code(0, 7); // end of block
  body.put(0, 3);
  body.align();
  body.raw(stored(false, 5 + 1 + 4 + 20).slice(1));
  const last = body.bytes.length;
  body.raw([...stored(true, 1), 0x7a, 0, 0, 0, 0]);
  // Object 2 as the scan sees it: everything up to that header is a stored block, then one byte.
  const seen = [...body.bytes.slice(0, last), 0x7a];
  body.bytes.splice(last + 6, 4, ...adler32(seen));
  const hidden = [...adler32(shown), ...objectHeader(3, seen.length), 0x78, 0x01, ...stored(false, last)];
  first.raw([...stored(false, hidden.length), ...hidden]);
  out.push(...first.bytes, ...body.bytes, ...new Array(20).fill(0x11));
  return Uint8Array.from(out);
}

describe('the pack pre-scan', { timeout: 60_000 }, () => {
  it('accepts well-formed whole objects', () => {
    const summary = scanPack(pack([[3, 5, text('hello')], [3, 0, text('')], [3, 11, text('hello world')]]), LIMITS);
    expect(summary).toMatchObject({ objects: 3, inflated: 16, deltas: 0 });
  });

  it('refuses an object that inflates past what it declares (a decompression bomb)', () => {
    const bomb = new Uint8Array(512 * 1024);
    expect(() => scanPack(pack([[3, 10, bomb]]), LIMITS)).toThrow(PackRejected);
  });

  it('finds where an object ends as the indexer does, so a planted checksum hides no bomb', () => {
    const crafted = desynchronised(1000);
    // isomorphic-git's indexer inflates object 1 to its real end (pako, as zlib here): far past 9 bytes.
    expect(zlib.inflateSync(crafted.subarray(13), { finishFlush: zlib.constants.Z_SYNC_FLUSH }).length).toBeGreaterThan(250_000);
    // The scan once stopped at 9 bytes, took the planted checksum for the end and accepted both.
    expect(() => scanPack(crafted, LIMITS)).toThrow(/more than it declares/);
  });

  it('reads deflate streams of every kind to their exact ends', () => {
    let seed = 7;
    const noise = (length: number) => Uint8Array.from({ length }, () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) >>> 16);
    const contents = [
      new Uint8Array(0),
      text('a'),
      text('hello world'),
      new Uint8Array(70_000).fill(7),
      noise(5_000),
      // More than one stored block's worth.
      noise(70_000),
      text(`{"nodes":[${'{"id":"n","type":"service","text":"Payments API"},'.repeat(3_000)}{}]}`),
    ];
    const streams: [number, Uint8Array][] = [];
    for (const content of contents) {
      for (const level of [0, 1, 6, 9] as const) streams.push([content.length, zlibSync(content, { level })]);
      for (const strategy of [zlib.constants.Z_FIXED, zlib.constants.Z_HUFFMAN_ONLY, zlib.constants.Z_RLE]) streams.push([content.length, new Uint8Array(zlib.deflateSync(content, { strategy }))]);
    }
    // A sync flush (an empty stored block) inside one stream, then a final block.
    const [front, back] = [contents[6]!.subarray(0, 40_000), contents[6]!.subarray(40_000)];
    const flushed = [...zlib.deflateRawSync(front, { finishFlush: zlib.constants.Z_SYNC_FLUSH }), ...zlib.deflateRawSync(back)];
    streams.push([contents[6]!.length, Uint8Array.from([0x78, 0x9c, ...flushed, ...adler32(contents[6]!)])]);
    const parts: number[] = [0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, streams.length];
    for (const [size, stream] of streams) {
      parts.push(...objectHeader(3, size));
      for (const byte of stream) parts.push(byte);
    }
    for (let i = 0; i < 20; i += 1) parts.push(0);
    const summary = scanPack(Uint8Array.from(parts), LIMITS);
    expect(summary).toEqual({ objects: streams.length, inflated: streams.reduce((sum, [size]) => sum + size, 0), deltas: 0 });
  });

  it('reads codes up to 15 bits long to the size and end zlib reads them to', () => {
    // End of block at one bit, `a` to `m` at two to fourteen, and `n` and a length of three at fifteen.
    const literals = new Array<number>(258).fill(0);
    literals[256] = 1;
    for (let i = 0; i < 13; i += 1) literals[97 + i] = i + 2;
    literals[110] = 15;
    literals[257] = 15;
    // A distance of one at fifteen bits, beside one at fifteen and one at each of fourteen to one.
    const distances = Array.from({ length: 16 }, (_, symbol) => (symbol < 2 ? 15 : 16 - symbol));
    const w = new BitWriter();
    dynamicBlock(w, true, literals, distances, [
      ['literal', 97, 0, 0],
      ['literal', 110, 0, 0],
      ['literal', 109, 0, 0],
      ['literal', 257, 0, 0],
      ['distance', 0, 0, 0],
      ['literal', 256, 0, 0],
    ]);
    w.align();
    const stream = [0x78, 0x01, ...w.bytes, ...adler32(text('anmmmm'))];
    expect(new TextDecoder().decode(zlib.inflateSync(Uint8Array.from(stream)))).toBe('anmmmm');
    // The object after it is found only where zlib ends this one.
    const parts = [0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 2, ...objectHeader(3, 6), ...stream, ...objectHeader(3, 5), ...zlibSync(text('hello')), ...new Array<number>(20).fill(0)];
    expect(scanPack(Uint8Array.from(parts), LIMITS)).toEqual({ objects: 2, inflated: 11, deltas: 0 });
  });

  it('builds tables as deep as a block’s codes need, so blocks of 15-bit codes holding nothing cost little', () => {
    // Nothing in each block but its end, yet its literal and distance codes both reach fifteen bits.
    const literals = new Array<number>(257).fill(0);
    literals[256] = 1;
    for (let i = 0; i < 14; i += 1) literals[i] = i + 2;
    literals[14] = 15;
    const distances = Array.from({ length: 16 }, (_, symbol) => (symbol === 15 ? 15 : symbol + 1));
    const blocks = 200;
    const w = new BitWriter();
    for (let b = 0; b < blocks; b += 1) dynamicBlock(w, false, literals, distances, [['literal', 256, 0, 0]]);
    // A final fixed block with `a` in it.
    w.put(1, 1);
    w.put(1, 2);
    w.code(0x30 + 0x61, 8);
    w.code(0, 7);
    w.align();
    const stream = [0x78, 0x01, ...w.bytes, ...adler32(text('a'))];
    expect(zlib.inflateSync(Uint8Array.from(stream)).length).toBe(1);
    const work: ScanWork = { tableEntries: 0 };
    const parts = [0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 1, ...objectHeader(3, 1), ...stream, ...new Array<number>(20).fill(0)];
    expect(scanPack(Uint8Array.from(parts), LIMITS, work)).toEqual({ objects: 1, inflated: 1, deltas: 0 });
    // A table indexed by every bit of the longest code took 2^15 entries for each of a block's two
    // codes, and a pack of such blocks seconds a megabyte to scan. Built as zlib builds them, a
    // block's tables take 1,184: 32 for its code lengths, and 512 + 64 for each of its two codes.
    expect(work.tableEntries).toBe(blocks * 1_184);
  });

  it('refuses an object declared larger than any diagram', () => {
    expect(() => scanPack(pack([[3, 2 * 1024 * 1024, new Uint8Array(2 * 1024 * 1024)]]), LIMITS)).toThrow(/larger than/);
  });

  it('refuses more objects than allowed, a short pack, and trailing data', () => {
    expect(() => scanPack(pack([[3, 1, text('a')]]), { ...LIMITS, maxObjects: 0 })).toThrow(/at most 0/);
    const whole = pack([[3, 5, text('hello')]]);
    const claimsTwo = whole.slice();
    claimsTwo[11] = 2;
    expect(() => scanPack(claimsTwo, LIMITS)).toThrow(PackRejected);
    expect(() => scanPack(pack([[3, 5, text('hello')]], Uint8Array.from([1, 2, 3])), LIMITS)).toThrow(/after its last object/);
  });

  it('refuses something that is not a pack', () => {
    expect(() => scanPack(new Uint8Array(64), LIMITS)).toThrow(/Not a Git pack/);
  });

  it('counts a delta that names its base by id as deeper than everything before it', () => {
    const chain = (length: number) => deltaChain(new Array<'ref'>(length).fill('ref'));
    expect(scanPack(chain(LIMITS.maxDeltaDepth), LIMITS).deltas).toBe(LIMITS.maxDeltaDepth);
    // Each once counted as one level deep, so a chain of them of any length went through.
    expect(() => scanPack(chain(LIMITS.maxDeltaDepth + 1), LIMITS)).toThrow(/deeper than allowed/);
    // An offset delta goes on from the depth of a by-id one it is built on, and the other way round.
    const mixed = (length: number) => deltaChain(Array.from({ length }, (_, i) => (i % 2 === 0 ? 'ref' : 'ofs')));
    expect(scanPack(mixed(LIMITS.maxDeltaDepth), LIMITS).deltas).toBe(LIMITS.maxDeltaDepth);
    expect(() => scanPack(mixed(LIMITS.maxDeltaDepth + 1), LIMITS)).toThrow(/deeper than allowed/);
  });

  it('refuses a delta that points before the pack', () => {
    const bad = pack([[3, 5, text('hello')]]);
    // Rewrite the object as an offset delta whose base would sit before the pack's header.
    const out = Uint8Array.from([...bad.subarray(0, 12), 0x65, 0x7f, ...bad.subarray(13)]);
    expect(() => scanPack(out, LIMITS)).toThrow(PackRejected);
  });

  it.skipIf(!HAS_GIT)('accepts packs Git writes, with deltas', () => {
    const { dir, done } = scratch();
    try {
      gitOk(dir, ['init', '-q', 'w']);
      const work = join(dir, 'w');
      for (let i = 0; i < 6; i += 1) {
        writeFileSync(join(work, 'diagram.draftcanvas'), `${'line of a diagram\n'.repeat(200)}${i}\n`);
        gitOk(work, ['add', '.']);
        gitOk(work, ['commit', '-q', '-m', `r${i}`]);
      }
      gitOk(work, ['gc', '-q', '--aggressive']);
      const packDir = join(work, '.git', 'objects', 'pack');
      const file = readdirSync(packDir).find((name) => name.endsWith('.pack'))!;
      const summary = scanPack(new Uint8Array(readFileSync(join(packDir, file))), LIMITS);
      expect(summary.objects).toBe(18);
      expect(summary.deltas).toBeGreaterThan(0);
    } finally {
      done();
    }
  });
});
