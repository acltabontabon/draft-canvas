import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FRAME_HEADER_BYTES,
  MAX_CHUNK_BYTES,
  MAX_MESSAGE_BYTES,
  REASSEMBLY_TIMEOUT_MS,
  Reassembler,
  encodeFrames,
  type DropReason,
  type FrameKind,
} from '../src/collab/transport/chunk';

function collector(options: Partial<ConstructorParameters<typeof Reassembler>[0]> = {}) {
  const messages: [string, FrameKind][] = [];
  const drops: [DropReason, string][] = [];
  const reassembler = new Reassembler({
    onMessage: (text, kind) => messages.push([text, kind]),
    onDrop: (reason, detail) => drops.push([reason, detail]),
    ...options,
  });
  return { reassembler, messages, drops };
}

function frame(id: number, index: number, count: number, payload: number[] = [0x61], header: Partial<{ version: number; kind: number }> = {}): Uint8Array {
  const bytes = new Uint8Array(FRAME_HEADER_BYTES + payload.length);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, header.version ?? 1);
  view.setUint8(1, header.kind ?? 0);
  view.setUint32(2, id);
  view.setUint16(6, index);
  view.setUint16(8, count);
  bytes.set(payload, FRAME_HEADER_BYTES);
  return bytes;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('framing', () => {
  it('sends a small message as one frame and reads it back', () => {
    const frames = encodeFrames('{"op":"hello"}', 7);
    expect(frames).toHaveLength(1);
    const { reassembler, messages } = collector();
    reassembler.push(frames[0]!.buffer);
    expect(messages).toEqual([['{"op":"hello"}', 'message']]);
  });

  it('splits a large message into frames of at most 64 KiB, including multi-byte characters at the seams', () => {
    const text = '→✓ draft 🎨 '.repeat(30_000);
    const frames = encodeFrames(text, 1);
    expect(frames.length).toBeGreaterThan(5);
    for (const f of frames) expect(f.length).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
    const { reassembler, messages, drops } = collector();
    for (const f of frames) reassembler.push(f);
    expect(drops).toEqual([]);
    expect(messages).toEqual([[text, 'message']]);
    expect(reassembler.pendingBytes).toBe(0);
  });

  it('honours a smaller peer limit, but never goes below the floor that keeps the count in 16 bits', () => {
    const text = 'x'.repeat(50_000);
    expect(encodeFrames(text, 1, 'message', 16_384).every((f) => f.length <= 16_384)).toBe(true);
    const floor = encodeFrames(text, 1, 'message', 10);
    expect(floor[0]!.length).toBe(1024);
    expect(floor.every((f) => f.length <= 1024)).toBe(true);
  });

  it('carries the control kind separately from application messages', () => {
    const { reassembler, messages } = collector();
    for (const f of encodeFrames('{"t":"restart-offer"}', 3, 'control')) reassembler.push(f);
    expect(messages).toEqual([['{"t":"restart-offer"}', 'control']]);
  });

  it('sends an empty message as one empty frame', () => {
    const { reassembler, messages } = collector();
    const frames = encodeFrames('', 0);
    expect(frames).toHaveLength(1);
    reassembler.push(frames[0]);
    expect(messages).toEqual([['', 'message']]);
  });

  it('refuses to frame a message over 16 MiB', () => {
    expect(() => encodeFrames('x'.repeat(MAX_MESSAGE_BYTES + 1), 0)).toThrow(RangeError);
  });

  it('reassembles chunks that arrive out of order and interleaved with other messages', () => {
    const first = encodeFrames('a'.repeat(200_000), 1);
    const second = encodeFrames('b'.repeat(150_000), 2);
    const { reassembler, messages, drops } = collector();
    const mixed = [...first.reverse(), ...second].sort((x, y) => (x[7]! % 2) - (y[7]! % 2));
    for (const f of mixed) reassembler.push(f);
    expect(drops).toEqual([]);
    expect(messages.map(([text]) => text.charAt(0) + text.length).sort()).toEqual(['a200000', 'b150000']);
  });

  it('reassembles any message from its chunks in any order', () => {
    fc.assert(fc.property(fc.string({ unit: 'grapheme', maxLength: 3000 }), fc.integer({ min: 1024, max: 4096 }), fc.integer(), (text, size, seed) => {
      const frames = encodeFrames(text, seed >>> 0, 'message', size);
      const shuffled = frames.map((f, i) => [((i + 1) * (seed | 1)) % 9973, f] as const).sort((x, y) => x[0] - y[0]).map(([, f]) => f);
      const { reassembler, messages, drops } = collector();
      for (const f of shuffled) reassembler.push(f);
      expect(drops).toEqual([]);
      expect(messages).toEqual([[text, 'message']]);
      reassembler.dispose();
    }), { seed: 20261022, numRuns: 150 });
  });
});

describe('untrusted frames', () => {
  it('drops and reports malformed frames instead of throwing', () => {
    const { reassembler, messages, drops } = collector();
    reassembler.push('text frame');
    reassembler.push(new Uint8Array(3));
    reassembler.push(frame(1, 0, 1, [0x61], { version: 2 }));
    reassembler.push(frame(1, 0, 1, [0x61], { kind: 9 }));
    reassembler.push(frame(1, 0, 0));
    reassembler.push(frame(1, 4, 4));
    reassembler.push(frame(1, 0, 1, [0xff, 0xfe]));
    reassembler.push(new Uint8Array(MAX_CHUNK_BYTES + 1));
    reassembler.push(null);
    expect(messages).toEqual([]);
    expect(drops.map(([reason]) => reason)).toEqual(['malformed', 'malformed', 'malformed', 'malformed', 'malformed', 'malformed', 'malformed', 'oversize', 'malformed']);
  });

  it('drops a chunk that arrives twice but still completes the message', () => {
    const { reassembler, messages, drops } = collector();
    reassembler.push(frame(5, 0, 2, [0x61]));
    reassembler.push(frame(5, 0, 2, [0x61]));
    reassembler.push(frame(5, 1, 2, [0x62]));
    expect(drops.map(([reason]) => reason)).toEqual(['malformed']);
    expect(messages).toEqual([['ab', 'message']]);
  });

  it('discards a message whose chunks disagree about its shape', () => {
    const { reassembler, messages, drops } = collector();
    reassembler.push(frame(5, 0, 3));
    reassembler.push(frame(5, 1, 2));
    expect(drops.map(([reason]) => reason)).toEqual(['malformed']);
    reassembler.push(frame(5, 0, 2, [0x63]));
    expect(messages).toEqual([['ca', 'message']]);
  });

  it('caps a message at its byte limit', () => {
    const { reassembler, messages, drops } = collector({ maxMessageBytes: 3 });
    reassembler.push(frame(1, 0, 3, [1, 2]));
    reassembler.push(frame(1, 1, 3, [3, 4]));
    expect(drops.map(([reason]) => reason)).toEqual(['oversize']);
    expect(reassembler.pendingMessages).toBe(0);
    reassembler.push(frame(2, 0, 1, [0x61, 0x62, 0x63, 0x64]));
    expect(drops.map(([reason]) => reason)).toEqual(['oversize', 'oversize']);
    expect(messages).toEqual([]);
  });

  it('caps the bytes held across all partial messages', () => {
    const { reassembler, drops } = collector({ maxMessageBytes: 4 });
    reassembler.push(frame(1, 0, 2, [1, 2, 3]));
    reassembler.push(frame(2, 0, 2, [1, 2]));
    expect(drops.map(([reason]) => reason)).toEqual(['overflow']);
    expect(reassembler.pendingBytes).toBe(3);
  });

  it('caps how many messages may be partially received at once', () => {
    const { reassembler, drops } = collector({ maxPartialMessages: 2 });
    reassembler.push(frame(1, 0, 2));
    reassembler.push(frame(2, 0, 2));
    reassembler.push(frame(3, 0, 2));
    expect(drops).toEqual([['overflow', 'more than 2 messages in flight']]);
    expect(reassembler.pendingMessages).toBe(2);
  });

  it('gives up on a message that is not finished within 15 s, and leaves no timer behind', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { reassembler, messages, drops } = collector();
    reassembler.push(frame(1, 0, 2));
    vi.advanceTimersByTime(REASSEMBLY_TIMEOUT_MS / 2);
    reassembler.push(frame(2, 0, 2));
    vi.advanceTimersByTime(REASSEMBLY_TIMEOUT_MS / 2);
    expect(drops.map(([reason]) => reason)).toEqual(['timeout']);
    expect(reassembler.pendingMessages).toBe(1);
    reassembler.push(frame(2, 1, 2, [0x62]));
    expect(messages).toEqual([['ab', 'message']]);
    expect(vi.getTimerCount()).toBe(0);
    // The late chunk of the expired message starts over rather than completing it.
    reassembler.push(frame(1, 1, 2));
    expect(reassembler.pendingMessages).toBe(1);
    reassembler.dispose();
    expect(vi.getTimerCount()).toBe(0);
    reassembler.push(frame(9, 0, 1));
    expect(messages).toHaveLength(1);
  });

  it('times a message out only when it stalls: a slow one still arriving is never dropped', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { reassembler, messages, drops } = collector();
    const count = 6;
    // A chunk every 2/3 of the timeout: the whole message takes far longer than the timeout.
    for (let index = 0; index < count; index++) {
      reassembler.push(frame(1, index, count, [0x61 + index]));
      if (index < count - 1) vi.advanceTimersByTime((REASSEMBLY_TIMEOUT_MS * 2) / 3);
    }
    expect(drops).toEqual([]);
    expect(messages).toEqual([['abcdef', 'message']]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never throws, whatever bytes arrive', () => {
    fc.assert(fc.property(fc.array(fc.uint8Array({ maxLength: 64 }), { maxLength: 40 }), (frames) => {
      const { reassembler } = collector({ maxPartialMessages: 3 });
      for (const f of frames) expect(() => reassembler.push(f)).not.toThrow();
      reassembler.dispose();
    }), { seed: 20261022, numRuns: 300 });
  });
});
