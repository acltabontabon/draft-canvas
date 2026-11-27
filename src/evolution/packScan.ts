/**
 * A bounded pre-scan of an untrusted Git pack, run before any Git library inflates it.
 *
 * isomorphic-git and gix verify a pack's object ids; neither bounds how much one object may inflate
 * to, and a few kilobytes of deflate can claim gigabytes. This walks the pack once with a streaming
 * inflater whose output is counted and capped, so a bomb, an object larger than any diagram, a
 * delta chain deeper than Git itself would write, or a pack that claims more objects than it holds
 * is refused while it is still a byte array (docs/reference/evolution-security.md).
 *
 * It does not hash objects or resolve deltas — that is the library's job, and it happens next. A
 * pack this accepts may still be refused there; nothing this refuses is ever indexed.
 *
 * Owned code, narrowly scoped (ADR-1): no library offers a size-bounded pack walk.
 */
import { Unzlib } from 'fflate';

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

export class PackRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackRejected';
  }
}

const CHUNK = 4096;
const TYPES = new Set([1, 2, 3, 4, 6, 7]);

function adler32Step(state: { a: number; b: number }, data: Uint8Array): void {
  let { a, b } = state;
  for (let i = 0; i < data.length; i += 1) {
    a = (a + data[i]!) % 65521;
    b = (b + a) % 65521;
  }
  state.a = a;
  state.b = b;
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
 * Inflates one zlib stream starting at `start`, never producing more than `declared` bytes, and
 * returns where it ends plus its first bytes (enough for a delta header).
 */
function inflateBounded(pack: Uint8Array, start: number, end: number, declared: number): { next: number; head: Uint8Array } {
  let produced = 0;
  let overflow = false;
  const adler = { a: 1, b: 0 };
  const head: number[] = [];
  const stream = new Unzlib((data) => {
    produced += data.length;
    if (produced > declared) {
      overflow = true;
      return;
    }
    adler32Step(adler, data);
    for (let i = 0; i < data.length && head.length < 32; i += 1) head.push(data[i]!);
  });
  let at = start;
  let completedIn = -1;
  while (at < end) {
    const chunkStart = at;
    const chunkEnd = Math.min(end, at + CHUNK);
    try {
      stream.push(pack.subarray(chunkStart, chunkEnd), false);
    } catch {
      throw new PackRejected('An object’s compressed data is damaged.');
    }
    if (overflow) throw new PackRejected('An object inflates to more than it declares.');
    at = chunkEnd;
    if (produced === declared) {
      completedIn = chunkStart;
      // The stream's own end (its checksum) may still be in the next few bytes.
      break;
    }
  }
  if (produced !== declared) throw new PackRejected('An object inflates to less than it declares.');
  const checksum = [(adler.b >>> 8) & 0xff, adler.b & 0xff, (adler.a >>> 8) & 0xff, adler.a & 0xff];
  // The deflate data finished somewhere in the chunk that completed the output (or right after
  // the zlib header, for an empty object): the checksum follows it.
  const from = Math.max(start + 2, completedIn);
  const until = Math.min(end - 4, at + 8);
  for (let p = from; p <= until; p += 1) {
    if (pack[p] === checksum[0] && pack[p + 1] === checksum[1] && pack[p + 2] === checksum[2] && pack[p + 3] === checksum[3]) {
      return { next: p + 4, head: Uint8Array.from(head) };
    }
  }
  throw new PackRejected('An object’s compressed data does not end where it should.');
}

/** Walks every entry of a version 2 or 3 pack within `limits`. `pack` includes its 20-byte trailer. */
export function scanPack(pack: Uint8Array, limits: PackLimits): PackSummary {
  if (pack.length < 32) throw new PackRejected('The pack is too short.');
  if (pack[0] !== 0x50 || pack[1] !== 0x41 || pack[2] !== 0x43 || pack[3] !== 0x4b) throw new PackRejected('Not a Git pack.');
  const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  const version = view.getUint32(4);
  if (version !== 2 && version !== 3) throw new PackRejected(`Pack version ${version} is not supported.`);
  const count = view.getUint32(8);
  if (count > limits.maxObjects) throw new PackRejected(`The pack holds ${count} objects; at most ${limits.maxObjects} are accepted.`);
  const end = pack.length - 20;
  const depthAt = new Map<number, number>();
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
      // A base named by id may be anywhere: count it as one more level than the deepest so far.
      depth = 1;
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
    at = next;
  }
  if (at !== end) throw new PackRejected('The pack has data after its last object.');
  return { objects: count, inflated, deltas };
}
