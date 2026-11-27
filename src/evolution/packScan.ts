/**
 * A bounded pre-scan of an untrusted Git pack, run before any Git library inflates it.
 *
 * isomorphic-git and gix verify a pack's object ids; neither bounds how much one object may inflate
 * to, and a few kilobytes of deflate can claim gigabytes. This walks the pack once, decoding each
 * object's deflate stream to its exact end and counting what it produces against what the object
 * declares, so a bomb, an object larger than any diagram, a delta chain deeper than Git itself would
 * write, or a pack that claims more objects than it holds is refused while it is still a byte array
 * (docs/reference/evolution.md#threats-and-mitigations).
 *
 * It does not hash objects, check zlib's checksums or resolve deltas — that is the library's job,
 * and it happens next. A pack this accepts may still be refused there; nothing this refuses is ever
 * indexed.
 *
 * Owned code, narrowly scoped (ADR-1): no library offers a size-bounded pack walk.
 */

export interface PackLimits {
  maxObjects: number;
  /** Largest inflated object, and largest delta result. */
  maxObjectBytes: number;
  /** Sum of every inflated object. */
  maxTotalInflated: number;
  maxDeltaDepth: number;
}

export interface PackSummary {
  objects: number;
  inflated: number;
  deltas: number;
}

/** What a scan spent on decoding tables, so a test can hold it to a bound without timing it. */
export interface ScanWork {
  /** Entries of every table built for a block's own codes, sub-tables included. */
  tableEntries: number;
}

export class PackRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackRejected';
  }
}

const TYPES = new Set([1, 2, 3, 4, 6, 7]);

/** Deflate's length and distance codes (RFC 1951, 3.2.5): base values and extra bits. */
const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DISTANCE_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DISTANCE_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
/** The order in which a dynamic block sends the lengths of its code length code. */
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/**
 * A canonical Huffman code as zlib's inflater keeps one (`inflate_table`): a root table indexed by the
 * stream's next `bits` bits, each entry `symbol << 4 | length` or 0 for no code, and for each root
 * prefix that longer codes share, a sub-table indexed by the bits after it. Such a prefix's root entry
 * reads as `LONGER` plus its root index, taking the root bits, and `subs` at that index says where in
 * `table` its sub-table starts and how many bits index it: `offset << 4 | depth`.
 */
interface Code {
  table: Uint16Array;
  bits: number;
  subs: Uint16Array | null;
}

/**
 * Past every real symbol, so the root entry of a longer code goes where a symbol out of range goes,
 * and only there is the rest of it read: the decoding of every other symbol stays as it always was.
 */
const LONGER = 512;

/**
 * Bits a root table is indexed by, zlib's own choices. One table indexed by every bit of the longest
 * code took 2^15 entries for a block whose longest code is 15 bits, however little the block held: a
 * pack of nothing but such blocks scanned at seconds a megabyte, on the desktop's UI thread. Rooted
 * here, a block's tables take at most 852 entries for its literals and lengths, and 592 for its
 * distances (zlib's ENOUGH): what its codes need, not 2^15, and offsets a 16-bit entry holds.
 */
const LITERAL_ROOT = 9;
const DISTANCE_ROOT = 6;
/** Code lengths are at most 7 bits long: one table always. */
const CODE_LENGTH_ROOT = 7;

const damaged = () => new PackRejected('An object’s compressed data is damaged.');
const cutShort = () => new PackRejected('An object’s compressed data is cut short.');

/** `value`'s low `bits` bits in reverse: codes are sent most significant bit first, in a stream read least significant bit first. */
function reversed(value: number, bits: number): number {
  let out = 0;
  for (let i = 0; i < bits; i += 1) out |= ((value >>> i) & 1) << (bits - 1 - i);
  return out;
}

/**
 * The code these lengths describe, accepted exactly as zlib accepts it: never over-subscribed, and
 * incomplete only as a single one-bit code — never for the code length code (`complete`). A code
 * with no lengths at all is accepted and fails only when a symbol is read from it. Its root table
 * is indexed by at most `rootBits` bits.
 */
function huffman(lengths: ArrayLike<number>, complete: boolean, rootBits: number): Code {
  const count = new Array<number>(16).fill(0);
  let max = 0;
  for (let i = 0; i < lengths.length; i += 1) {
    const length = lengths[i]!;
    count[length] = count[length]! + 1;
    max = Math.max(max, length);
  }
  if (max === 0) return { table: new Uint16Array(1), bits: 0, subs: null };
  let left = 1;
  for (let length = 1; length <= 15; length += 1) {
    left = left * 2 - count[length]!;
    if (left < 0) throw damaged();
  }
  if (left > 0 && (complete || max !== 1)) throw damaged();
  const next = new Array<number>(16).fill(0);
  for (let length = 2; length <= 15; length += 1) next[length] = (next[length - 1]! + count[length - 1]!) * 2;
  if (max > rootBits) return rooted(lengths, count, next, rootBits);
  // Short enough for one table, indexed by every bit of the longest code.
  const table = new Uint16Array(1 << max);
  for (let symbol = 0; symbol < lengths.length; symbol += 1) {
    const length = lengths[symbol]!;
    if (length === 0) continue;
    const code = next[length]!;
    next[length] = code + 1;
    // Codes are sent most significant bit first, in a stream read least significant bit first.
    let index = 0;
    for (let i = 0; i < length; i += 1) index |= ((code >>> i) & 1) << (length - 1 - i);
    for (; index < table.length; index += 1 << length) table[index] = (symbol << 4) | length;
  }
  return { table, bits: max, subs: null };
}

/**
 * `huffman`'s table for a code longer than its root: the root, then a sub-table for each root prefix
 * that longer codes share, as deep as the longest of them. `next` is each length's first code.
 */
function rooted(lengths: ArrayLike<number>, count: number[], next: number[], bits: number): Code {
  // Every code in canonical order (by length, then symbol), in which codes only grow: the longer codes
  // that share a root prefix come together, the longest of them last.
  const place = new Array<number>(17).fill(0);
  for (let length = 1; length <= 15; length += 1) place[length + 1] = place[length]! + count[length]!;
  const used = place[16]!;
  const short = place[bits + 1]!;
  const sorted = new Int32Array(used);
  for (let symbol = 0; symbol < lengths.length; symbol += 1) {
    const length = lengths[symbol]!;
    if (length === 0) continue;
    const at = place[length]!;
    const code = next[length]!;
    place[length] = at + 1;
    next[length] = code + 1;
    sorted[at] = (code << 13) | (length << 9) | symbol;
  }
  let size = 1 << bits;
  for (let at = short; at < used; ) {
    const end = runEnd(sorted, at, bits);
    size += 1 << (lengthOf(sorted[end - 1]!) - bits);
    at = end;
  }
  const table = new Uint16Array(size);
  const subs = new Uint16Array(1 << bits);
  for (let at = 0; at < short; at += 1) {
    const item = sorted[at]!;
    const length = lengthOf(item);
    for (let index = reversed(item >>> 13, length); index < 1 << bits; index += 1 << length) table[index] = ((item & 511) << 4) | length;
  }
  for (let at = short, offset = 1 << bits; at < used; ) {
    const end = runEnd(sorted, at, bits);
    const depth = lengthOf(sorted[end - 1]!) - bits;
    const root = reversed(prefixOf(sorted[at]!, bits), bits);
    table[root] = ((LONGER + root) << 4) | bits;
    subs[root] = (offset << 4) | depth;
    for (; at < end; at += 1) {
      const item = sorted[at]!;
      const rest = lengthOf(item) - bits;
      for (let index = reversed((item >>> 13) & ((1 << rest) - 1), rest); index < 1 << depth; index += 1 << rest) table[offset + index] = ((item & 511) << 4) | rest;
    }
    offset += 1 << depth;
  }
  return { table, bits, subs };
}

/** A code in canonical order, as `rooted` sorts them: `code << 13 | length << 9 | symbol`. */
function lengthOf(item: number): number {
  return (item >>> 9) & 15;
}

/** The code's first `bits` bits, as they are read: the root prefix it shares with its neighbours. */
function prefixOf(item: number, bits: number): number {
  return item >>> (13 + lengthOf(item) - bits);
}

/** Where the codes sharing the root prefix of the one at `from` end. */
function runEnd(sorted: Int32Array, from: number, bits: number): number {
  const prefix = prefixOf(sorted[from]!, bits);
  let end = from + 1;
  while (end < sorted.length && prefixOf(sorted[end]!, bits) === prefix) end += 1;
  return end;
}

/** Entries of the tables built for blocks' own codes since the module loaded, for `ScanWork`. */
let tableEntries = 0;

let fixed: { literals: Code; distances: Code } | null = null;

function fixedCodes(): { literals: Code; distances: Code } {
  fixed ??= {
    literals: huffman([...new Array<number>(144).fill(8), ...new Array<number>(112).fill(9), ...new Array<number>(24).fill(7), ...new Array<number>(8).fill(8)], false, LITERAL_ROOT),
    distances: huffman(new Array<number>(32).fill(5), false, DISTANCE_ROOT),
  };
  return fixed;
}

/** The size varint a delta's data starts with (base size, then result size). */
function deltaVarint(data: Uint8Array, at: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let i = at;
  for (;;) {
    if (i >= data.length || shift > 35) throw new PackRejected('A delta header is cut short.');
    const byte = data[i]!;
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    i += 1;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: i };
}

/**
 * Reads one zlib stream starting at `start` to its exact end, as any inflater reads it, counting
 * what it produces and refusing it the moment that passes `declared`. Returns where the stream
 * ends (after its checksum) and its first bytes, enough for a delta header. Nothing else of what
 * it produces is kept.
 *
 * Where an object ends is where the next begins, so this must agree with the indexer byte for
 * byte. It once inflated only until the declared size was reached and then searched the next few
 * bytes for the checksum: a pack with that checksum planted where the scan looked, and the real
 * stream carrying on, read here as two harmless objects while isomorphic-git's indexer inflated
 * the first to its true end — over a hundred megabytes for an object declared as 9 bytes.
 */
function inflateBounded(pack: Uint8Array, start: number, end: number, declared: number): { next: number; head: Uint8Array } {
  if (start + 2 > end) throw cutShort();
  const cmf = pack[start]!;
  const flg = pack[start + 1]!;
  // Deflate, a window zlib accepts, a header that checks, and no preset dictionary.
  if ((cmf & 0x0f) !== 8 || cmf >>> 4 > 7 || ((cmf << 8) | flg) % 31 !== 0 || flg & 0x20) throw damaged();
  const limit = end * 8;
  let pos = (start + 2) * 8;
  let produced = 0;
  const head = new Uint8Array(32);
  const peek = (count: number): number => {
    const at = pos >>> 3;
    // Past the end of `pack` reads as zero bits; `take` and `decode` refuse once they pass `limit`.
    return (((pack[at] ?? 0) | ((pack[at + 1] ?? 0) << 8) | ((pack[at + 2] ?? 0) << 16)) >>> (pos & 7)) & ((1 << count) - 1);
  };
  const take = (count: number): number => {
    const value = peek(count);
    pos += count;
    if (pos > limit) throw cutShort();
    return value;
  };
  /** A symbol, or for a longer code `LONGER` plus its root index, with only its root bits read. */
  const decode = (code: Code): number => {
    const entry = code.table[peek(code.bits)]!;
    if (entry === 0) throw damaged();
    pos += entry & 15;
    if (pos > limit) throw cutShort();
    return entry >>> 4;
  };
  const grow = (count: number) => {
    produced += count;
    if (produced > declared) throw new PackRejected('An object inflates to more than it declares.');
  };
  let final = 0;
  do {
    final = take(1);
    const type = take(2);
    if (type === 0) {
      let at = (pos + 7) >>> 3;
      if (at + 4 > end) throw cutShort();
      const length = pack[at]! | (pack[at + 1]! << 8);
      if ((pack[at + 2]! | (pack[at + 3]! << 8)) !== (~length & 0xffff)) throw damaged();
      at += 4;
      if (at + length > end) throw cutShort();
      for (let i = 0; i < length && produced + i < head.length; i += 1) head[produced + i] = pack[at + i]!;
      grow(length);
      pos = (at + length) * 8;
      continue;
    }
    if (type === 3) throw damaged();
    let literals: Code;
    let distances: Code;
    if (type === 1) {
      ({ literals, distances } = fixedCodes());
    } else {
      const literalCount = take(5) + 257;
      const distanceCount = take(5) + 1;
      const codeLengthCount = take(4) + 4;
      if (literalCount > 286 || distanceCount > 30) throw damaged();
      const codeLengths = new Uint8Array(19);
      for (let i = 0; i < codeLengthCount; i += 1) codeLengths[CODE_LENGTH_ORDER[i]!] = take(3);
      const lengthCode = huffman(codeLengths, true, CODE_LENGTH_ROOT);
      const total = literalCount + distanceCount;
      const lengths = new Uint8Array(total);
      for (let filled = 0; filled < total; ) {
        const symbol = decode(lengthCode);
        if (symbol < 16) {
          lengths[filled++] = symbol;
          continue;
        }
        if (symbol === 16 && filled === 0) throw damaged();
        const value = symbol === 16 ? lengths[filled - 1]! : 0;
        const repeat = symbol === 16 ? 3 + take(2) : symbol === 17 ? 3 + take(3) : 11 + take(7);
        if (filled + repeat > total) throw damaged();
        lengths.fill(value, filled, filled + repeat);
        filled += repeat;
      }
      if (lengths[256] === 0) throw damaged();
      literals = huffman(lengths.subarray(0, literalCount), false, LITERAL_ROOT);
      distances = huffman(lengths.subarray(literalCount), false, DISTANCE_ROOT);
      tableEntries += lengthCode.table.length + literals.table.length + distances.table.length;
    }
    for (;;) {
      let symbol = decode(literals);
      if (symbol < 256) {
        if (produced < head.length) head[produced] = symbol;
        grow(1);
        continue;
      }
      if (symbol >= LONGER) {
        // The rest of a longer code, from its sub-table. Read here, and not in `decode`, it cost the
        // decoding of every other symbol nothing; there it made normal packs scan a few percent slower.
        const sub = literals.subs![symbol - LONGER]!;
        const entry = literals.table[(sub >>> 4) + peek(sub & 15)]!;
        if (entry === 0) throw damaged();
        pos += entry & 15;
        if (pos > limit) throw cutShort();
        symbol = entry >>> 4;
        if (symbol < 256) {
          if (produced < head.length) head[produced] = symbol;
          grow(1);
          continue;
        }
      }
      if (symbol === 256) break;
      const index = symbol - 257;
      if (index >= LENGTH_BASE.length) throw damaged();
      const length = LENGTH_BASE[index]! + take(LENGTH_EXTRA[index]!);
      let code = decode(distances);
      if (code >= DISTANCE_BASE.length) {
        if (code < LONGER) throw damaged();
        const sub = distances.subs![code - LONGER]!;
        const entry = distances.table[(sub >>> 4) + peek(sub & 15)]!;
        if (entry === 0) throw damaged();
        pos += entry & 15;
        if (pos > limit) throw cutShort();
        code = entry >>> 4;
        if (code >= DISTANCE_BASE.length) throw damaged();
      }
      const distance = DISTANCE_BASE[code]! + take(DISTANCE_EXTRA[code]!);
      if (distance > produced) throw damaged();
      for (let i = produced; i < produced + length && i < head.length; i += 1) head[i] = head[i - distance]!;
      grow(length);
    }
  } while (!final);
  if (produced !== declared) throw new PackRejected('An object inflates to less than it declares.');
  // zlib's checksum starts at the next byte. It is the indexer's to check, with the object ids.
  const next = ((pos + 7) >>> 3) + 4;
  if (next > end) throw cutShort();
  return { next, head: head.slice(0, Math.min(produced, head.length)) };
}

/**
 * Walks every entry of a version 2 or 3 pack within `limits`. `pack` includes its 20-byte trailer.
 * `work`, when given, counts what the walk spent on decoding tables.
 */
export function scanPack(pack: Uint8Array, limits: PackLimits, work?: ScanWork): PackSummary {
  const built = tableEntries;
  try {
    return walk(pack, limits);
  } finally {
    if (work) work.tableEntries += tableEntries - built;
  }
}

function walk(pack: Uint8Array, limits: PackLimits): PackSummary {
  if (pack.length < 32) throw new PackRejected('The pack is too short.');
  if (pack[0] !== 0x50 || pack[1] !== 0x41 || pack[2] !== 0x43 || pack[3] !== 0x4b) throw new PackRejected('Not a Git pack.');
  const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  const version = view.getUint32(4);
  if (version !== 2 && version !== 3) throw new PackRejected(`Pack version ${version} is not supported.`);
  const count = view.getUint32(8);
  if (count > limits.maxObjects) throw new PackRejected(`The pack holds ${count} objects; at most ${limits.maxObjects} are accepted.`);
  const end = pack.length - 20;
  const depthAt = new Map<number, number>();
  /** The deepest delta chain any entry so far can end in. */
  let deepest = 0;
  let at = 12;
  let inflated = 0;
  let deltas = 0;
  for (let n = 0; n < count; n += 1) {
    if (at >= end) throw new PackRejected('The pack ends before its last object.');
    const entryStart = at;
    let byte = pack[at++]!;
    const type = (byte >> 4) & 7;
    if (!TYPES.has(type)) throw new PackRejected('The pack holds an object of unknown type.');
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      if (at >= end || shift > 35) throw new PackRejected('An object header is cut short.');
      byte = pack[at++]!;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let depth = 0;
    if (type === 6) {
      byte = pack[at++]!;
      let offset = byte & 0x7f;
      while (byte & 0x80) {
        if (at >= end) throw new PackRejected('A delta offset is cut short.');
        byte = pack[at++]!;
        offset = (offset + 1) * 128 + (byte & 0x7f);
      }
      const base = entryStart - offset;
      if (offset <= 0 || base < 12 || !depthAt.has(base)) throw new PackRejected('A delta points outside the pack.');
      depth = depthAt.get(base)! + 1;
    } else if (type === 7) {
      at += 20;
      // A base named by id is found only by hashing objects as they are resolved, and nothing is
      // resolved here. So it counts as one more level than the deepest entry so far, never less than
      // its chain's real depth while its base comes before it: the only place isomorphic-git's indexer
      // finds one (it leaves the delta out otherwise). gix finds a base further on too, but resolves
      // each object once, from a work stack, so a longer chain costs it no more than the objects and
      // bytes these limits already bound. It once counted as one level whatever it was built on, and
      // a chain of them escaped the limit. More of them than `maxDeltaDepth` are refused even if each
      // is one level deep: Git writes offset deltas into a bundle, and Draft Canvas writes no deltas.
      depth = deepest + 1;
    }
    if (depth > limits.maxDeltaDepth) throw new PackRejected('A delta chain is deeper than allowed.');
    // A delta's declared size is the size of its instructions; the result size is checked below.
    if (size > limits.maxObjectBytes) throw new PackRejected('An object is larger than any diagram history holds.');
    const { next, head } = inflateBounded(pack, at, end, size);
    if (type === 6 || type === 7) {
      deltas += 1;
      const base = deltaVarint(head, 0);
      const result = deltaVarint(head, base.next);
      if (base.value > limits.maxObjectBytes || result.value > limits.maxObjectBytes) {
        throw new PackRejected('A delta builds an object larger than any diagram history holds.');
      }
      inflated += result.value;
    } else {
      inflated += size;
    }
    if (inflated > limits.maxTotalInflated) throw new PackRejected('The pack inflates to more than allowed.');
    depthAt.set(entryStart, depth);
    deepest = Math.max(deepest, depth);
    at = next;
  }
  if (at !== end) throw new PackRejected('The pack has data after its last object.');
  return { objects: count, inflated, deltas };
}
