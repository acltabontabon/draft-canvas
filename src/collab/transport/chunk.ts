/**
 * Framing for DataChannels: one application message in, a run of binary frames out, and back.
 *
 * A DataChannel caps how large one `send` may be (`max-message-size`, 64 KiB in some browsers), and a
 * single huge send would also hold up everything behind it, presence included. So every message is
 * split into frames of at most 64 KiB, each carrying a small header:
 *
 *   byte 0     format version (1)
 *   byte 1     kind: 0 = application message, 1 = transport control (ICE restart)
 *   bytes 2-5  message id, big-endian, wrapping
 *   bytes 6-7  chunk index
 *   bytes 8-9  chunk count
 *   bytes 10-  UTF-8 payload slice
 *
 * The receiving side is untrusted input: whatever arrives is checked against hard caps (16 MiB per
 * message and in flight, eight partial messages at once, 15 s without a new chunk), and anything that
 * fails is dropped and reported through `onDrop` — never thrown into the channel's event handler.
 */

export const FRAME_VERSION = 1;
export const FRAME_HEADER_BYTES = 10;
export const MAX_CHUNK_BYTES = 64 * 1024;
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
export const MAX_PARTIAL_MESSAGES = 8;
export const REASSEMBLY_TIMEOUT_MS = 15_000;
/** The smallest frame a sender will use, so a tiny peer `max-message-size` cannot overflow the u16 count. */
export const MIN_CHUNK_BYTES = 1024;

export type FrameKind = 'message' | 'control';
export type DropReason = 'malformed' | 'oversize' | 'overflow' | 'timeout';

const KIND_CODES: Record<FrameKind, number> = { message: 0, control: 1 };

/**
 * The frames for one message. Throws a `RangeError` for a message over `MAX_MESSAGE_BYTES`: no peer
 * would accept it, so it is the caller's bug to fix rather than something to drop quietly.
 */
export function encodeFrames(text: string, id: number, kind: FrameKind = 'message', maxChunkBytes = MAX_CHUNK_BYTES): Uint8Array<ArrayBuffer>[] {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > MAX_MESSAGE_BYTES) {
    throw new RangeError(`A collaboration message may be at most ${MAX_MESSAGE_BYTES} bytes; this one is ${bytes.length}.`);
  }
  const chunk = Math.min(MAX_CHUNK_BYTES, Math.max(MIN_CHUNK_BYTES, Math.floor(maxChunkBytes)));
  const room = chunk - FRAME_HEADER_BYTES;
  const count = Math.max(1, Math.ceil(bytes.length / room));
  const frames: Uint8Array<ArrayBuffer>[] = [];
  for (let index = 0; index < count; index++) {
    const slice = bytes.subarray(index * room, (index + 1) * room);
    const frame = new Uint8Array(FRAME_HEADER_BYTES + slice.length);
    const view = new DataView(frame.buffer);
    view.setUint8(0, FRAME_VERSION);
    view.setUint8(1, KIND_CODES[kind]);
    view.setUint32(2, id >>> 0);
    view.setUint16(6, index);
    view.setUint16(8, count);
    frame.set(slice, FRAME_HEADER_BYTES);
    frames.push(frame);
  }
  return frames;
}

/** A frame as it may arrive from a DataChannel: `ArrayBuffer`, a typed-array view, or (wrongly) text. */
function bytesOf(frame: unknown): Uint8Array | null {
  if (ArrayBuffer.isView(frame)) return new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
  // Tag check rather than `instanceof`: buffers from another realm (a worker, jsdom) still count.
  if (Object.prototype.toString.call(frame) === '[object ArrayBuffer]') return new Uint8Array(frame as ArrayBuffer);
  return null;
}

interface PartialMessage {
  kind: FrameKind;
  count: number;
  received: number;
  bytes: number;
  chunks: (Uint8Array | undefined)[];
  deadline: number;
}

export interface ReassemblerOptions {
  onMessage(text: string, kind: FrameKind): void;
  onDrop?(reason: DropReason, detail: string): void;
  maxMessageBytes?: number;
  maxPartialMessages?: number;
  timeoutMs?: number;
}

export class Reassembler {
  private readonly partials = new Map<number, PartialMessage>();
  private readonly options: ReassemblerOptions;
  private readonly maxMessageBytes: number;
  private readonly maxPartials: number;
  private readonly timeoutMs: number;
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private timer: ReturnType<typeof setTimeout> | null = null;
  private buffered = 0;
  private disposed = false;

  constructor(options: ReassemblerOptions) {
    this.options = options;
    this.maxMessageBytes = options.maxMessageBytes ?? MAX_MESSAGE_BYTES;
    this.maxPartials = options.maxPartialMessages ?? MAX_PARTIAL_MESSAGES;
    this.timeoutMs = options.timeoutMs ?? REASSEMBLY_TIMEOUT_MS;
  }

  /** Bytes held for messages that have not finished arriving. */
  get pendingBytes(): number {
    return this.buffered;
  }

  get pendingMessages(): number {
    return this.partials.size;
  }

  push(frame: unknown): void {
    if (this.disposed) return;
    const bytes = bytesOf(frame);
    if (!bytes) return this.drop('malformed', 'frame is not binary');
    if (bytes.length < FRAME_HEADER_BYTES) return this.drop('malformed', 'frame shorter than its header');
    if (bytes.length > MAX_CHUNK_BYTES) return this.drop('oversize', `frame of ${bytes.length} bytes`);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint8(0) !== FRAME_VERSION) return this.drop('malformed', `frame version ${view.getUint8(0)}`);
    const kindCode = view.getUint8(1);
    const kind: FrameKind | null = kindCode === 0 ? 'message' : kindCode === 1 ? 'control' : null;
    if (!kind) return this.drop('malformed', `frame kind ${kindCode}`);
    const id = view.getUint32(2);
    const index = view.getUint16(6);
    const count = view.getUint16(8);
    if (count === 0 || index >= count) return this.drop('malformed', `chunk ${index} of ${count}`);
    const payload = bytes.subarray(FRAME_HEADER_BYTES);

    if (count === 1) {
      if (this.partials.has(id)) return this.discard(id, 'malformed', `message ${id} restarted before it finished`);
      if (payload.length > this.maxMessageBytes) return this.drop('oversize', `message ${id}`);
      return this.deliver(payload, kind, id);
    }

    let partial = this.partials.get(id);
    if (partial && (partial.count !== count || partial.kind !== kind)) {
      // A drop may dispose this reassembler (the transport closes on malformed input). Never
      // recreate state after that callback, or keep part of the rejected replacement message.
      return this.discard(id, 'malformed', `message ${id} changed shape mid-way`);
    }
    if (!partial) {
      if (this.partials.size >= this.maxPartials) {
        return this.drop('overflow', `more than ${this.maxPartials} messages in flight`);
      }
      partial = { kind, count, received: 0, bytes: 0, chunks: new Array(count), deadline: Date.now() + this.timeoutMs };
      this.partials.set(id, partial);
      this.schedule();
    }
    if (partial.chunks[index]) return this.drop('malformed', `chunk ${index} of message ${id} arrived twice`);
    if (partial.bytes + payload.length > this.maxMessageBytes) {
      return this.discard(id, 'oversize', `message ${id} grew past ${this.maxMessageBytes} bytes`);
    }
    if (this.buffered + payload.length > this.maxMessageBytes) {
      return this.discard(id, 'overflow', `more than ${this.maxMessageBytes} bytes in flight`);
    }
    // Time without progress, not time to finish: a big snapshot over a slow link, or across a short
    // outage, takes longer than the timeout and is still arriving. (Only ever later, so the armed timer
    // at worst wakes early and `expire` re-arms it.)
    partial.deadline = Date.now() + this.timeoutMs;
    // Copied: the frame's buffer belongs to the channel event and may be large.
    partial.chunks[index] = payload.slice();
    partial.received++;
    partial.bytes += payload.length;
    this.buffered += payload.length;
    if (partial.received < partial.count) return;

    this.partials.delete(id);
    this.buffered -= partial.bytes;
    this.schedule();
    const whole = new Uint8Array(partial.bytes);
    let offset = 0;
    for (const chunk of partial.chunks) {
      whole.set(chunk!, offset);
      offset += chunk!.length;
    }
    this.deliver(whole, partial.kind, id);
  }

  /** Forgets every partial message and stops the timeout timer. Later frames are ignored. */
  dispose(): void {
    this.disposed = true;
    this.partials.clear();
    this.buffered = 0;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private deliver(payload: Uint8Array, kind: FrameKind, id: number): void {
    let text: string;
    try {
      text = this.decoder.decode(payload);
    } catch {
      return this.drop('malformed', `message ${id} is not UTF-8`);
    }
    this.options.onMessage(text, kind);
  }

  private discard(id: number, reason: DropReason, detail: string): void {
    const partial = this.partials.get(id);
    if (partial) {
      this.partials.delete(id);
      this.buffered -= partial.bytes;
      this.schedule();
    }
    this.drop(reason, detail);
  }

  private drop(reason: DropReason, detail: string): void {
    this.options.onDrop?.(reason, detail);
  }

  /** One timer, armed for the earliest deadline among partial messages, and none when there are none. */
  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.disposed || this.partials.size === 0) return;
    let earliest = Infinity;
    for (const partial of this.partials.values()) earliest = Math.min(earliest, partial.deadline);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.expire();
    }, Math.max(0, earliest - Date.now()));
  }

  private expire(): void {
    const now = Date.now();
    for (const [id, partial] of [...this.partials]) {
      if (partial.deadline > now) continue;
      this.partials.delete(id);
      this.buffered -= partial.bytes;
      this.drop('timeout', `message ${id} stalled for ${this.timeoutMs} ms (${partial.received}/${partial.count} chunks)`);
      // The transport's drop callback may dispose all remaining partials and reset the byte count.
      if (this.disposed) return;
    }
    this.schedule();
  }
}
